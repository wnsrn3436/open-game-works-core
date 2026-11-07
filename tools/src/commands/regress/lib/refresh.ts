/**
 * `ogw regress refresh` and admission (ogw.md `### regress refresh` and `### admission` of `## regress`): each regression
 * state brought to the core version of the harness and checked as a base, and each seed applied on that base and
 * admitted.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { exists, readJsonIfExists, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { commitPaths, git, gitRaw, head, revParse, showFile, tagExists, worktreeAdd, worktreeRemove } from '../../../lib/git.ts';
import { newId } from '../../../lib/ids.ts';
import { placeholderFailures } from '../../check/api.ts';
import { releasedProposals } from '../../core/api.ts';
import { compareVersions } from '../../core/lib/version.ts';
import { dataDir } from '../../env/lib/host.ts';
import { document, renderTable } from '../../loop/lib/markdown.ts';
import { costRows, renderCost } from '../../loop/lib/cost.ts';
import { translationLanguages } from '../../loop/dispatch.ts';
import type { JobRecord } from '../../../lib/jobs.ts';
import { catchOf, cleanFor, keysOf, targetChecks, type RegressCheckFile } from './keys.ts';
import { dataTool, stateSettings, upgradeCore } from './ops.ts';
import { admissionPath, latestPatch, readStates, seedDir, stateGame, type Admission, type Seed } from './repo.ts';
import { jobFacts, sideAgent, sideCheck, sideMerge, sideProbe, type FixerRun, type Side } from './side.ts';
import { checkInputs } from './inputs.ts';
import { every, regressPool, type RegressPool } from './pool.ts';
import { addedFailures } from './expect.ts';
import { rebasable, rebaseSeed, rebaseText, type SeedRebase } from './rebase.ts';

/** The number of checks of a base and of a seeded commit at admission. */
export const ADMISSION_CHECKS = 3;

/** The tag of the base of core version `v`. */
export function baseTag(version: string): string {
  return `base-${version}`;
}

/** The folder in the regress repo that keeps the base checks of a refresh, which `ogw regress seed` reuses. */
function baseChecksDir(repo: string, version: string): string {
  return join(repo, 'records', `refresh-${version}`);
}

function stale(reason: string, fields: Partial<Admission> = {}): Admission {
  return { result: 'stale', base: null, seeded: null, reference: null, catch: [], oracle: null, reason, added: null, at: Date.now(), ...fields };
}

/** A checkout of the regression state at a worktree path, as `ctx.game` gives it there. */
function checkoutAt(state: GameRepo, root: string): GameRepo {
  return { ...state, root, inWorktree: true };
}

/**
 * Applies a patch file on `from` in a worktree on branch `branch` and commits: the new commit, or why it does not apply.
 * With `regenerate`, `ogw data` runs before the commit.
 */
async function applyOn(ctx: Context, state: GameRepo, from: string, branch: string, patch: string, regenerate: boolean, message: string): Promise<{ commit: string } | { error: string }> {
  const worktree = join((await ctx.workspace()).worktrees, state.name, `admit-${newId()}`);
  await gitRaw(state.mainRoot, ['branch', '-D', branch], { env: ctx.env });
  await worktreeAdd(state.mainRoot, worktree, from, branch, { env: ctx.env });
  try {
    const applied = await gitRaw(worktree, ['apply', '-3', '--whitespace=nowarn', patch], { env: ctx.env });
    if (applied.code !== 0) return { error: `patch does not apply: ${(applied.stderr || applied.stdout).trim().split('\n').slice(0, 3).join(' ')}` };
    if (regenerate) {
      const failed = await dataTool(ctx, checkoutAt(state, worktree));
      if (failed !== null) return { error: `patch does not apply: ${failed}` };
    }
    await git(worktree, ['add', '--all'], { env: ctx.env });
    const staged = await gitRaw(worktree, ['diff', '--cached', '--quiet'], { env: ctx.env });
    if (staged.code === 0) return { error: 'patch does not apply: it changes nothing' };
    await git(worktree, ['commit', '--quiet', '--no-verify', '-m', message], { env: ctx.env });
    return { commit: await head(worktree, { env: ctx.env }) };
  } finally {
    await worktreeRemove(state.mainRoot, worktree, { env: ctx.env });
  }
}

/** What the refresh or the seed command works with (ogw.md `### regress refresh`). */
export interface RefreshRun {
  /** The regress repo. */
  repo: string;
  /** The side whose tool checks: the harness repo itself. */
  self: Side;
  version: string;
  /** The check inputs key of the harness repo HEAD (`checkInputs`). */
  inputs: string;
  pool: RegressPool;
}

export interface AdmitInput {
  run: RefreshRun;
  seed: Seed;
  base: string;
  baseChecks: readonly RegressCheckFile[];
}

/** Step 1 of admission: the seeded commit, and with `oracle` the reference commit; a stale admission when they do not apply. */
async function applySeed(ctx: Context, input: AdmitInput, state: GameRepo): Promise<{ seeded: string; reference: string | null } | Admission> {
  const { seed, run } = input;
  const { version, pool } = run;
  const patch = await latestPatch(run.repo, seed.id, version, 'patch');
  if (patch === null) return stale(`patch does not apply: no patch-<version>.diff at or below ${version}`, { base: input.base });
  const seeded = await pool.work(() => applyOn(ctx, state, input.base, `seed/${seed.id}-${version}`, patch.path, seed.manifest.regenerate, `seed ${seed.id} at ${version}`));
  if ('error' in seeded) return stale(seeded.error, { base: input.base });
  if (!seed.manifest.oracle) return { seeded: seeded.commit, reference: null };
  const fix = await latestPatch(run.repo, seed.id, version, 'reference');
  if (fix === null) return stale(`oracle: no reference-<version>.diff at or below ${version}`, { base: input.base, seeded: seeded.commit });
  const applied = await pool.work(() => applyOn(ctx, state, seeded.commit, `reference/${seed.id}-${version}`, fix.path, seed.manifest.regenerate, `reference fix of ${seed.id} at ${version}`));
  if ('error' in applied) return stale(`oracle: the reference fix does not apply: ${applied.error}`, { base: input.base, seeded: seeded.commit });
  return { seeded: seeded.commit, reference: applied.commit };
}

/**
 * Step 3 of admission: the catch of each of the checks of the seeded commit, which run together, with the base check of
 * the same number, and its text for the stale reason: an `unknown` catch with why (the error of a check that did not
 * run, or the reason of the catch).
 */
async function admissionCatches(ctx: Context, input: AdmitInput, state: string, seeded: string, work: string): Promise<{ catches: string[]; texts: string[]; files: (RegressCheckFile | null)[] }> {
  const manifest = input.seed.manifest;
  const { self, pool } = input.run;
  const checks = manifest.expect === 'caught' ? targetChecks(manifest) : null;
  const results = await every(
    Array.from({ length: ADMISSION_CHECKS }, async (_, i) => {
      const out = join(work, `seeded-${String(i + 1)}.json`);
      const checked = await pool.check(manifest.performance, () => sideCheck(ctx, self, { game: state, commit: seeded, out, checks, performance: manifest.performance, proof: null }));
      const base = input.baseChecks[i] ?? input.baseChecks[0];
      const file = 'file' in checked ? checked.file : null;
      const result = !('file' in checked) ? { catch: 'unknown', reason: checked.error } : base === undefined ? { catch: 'unknown', reason: 'no base check' } : catchOf(manifest, base, checked.file);
      return { ...result, file };
    }),
  );
  return { catches: results.map((r) => r.catch), texts: results.map((r) => (r.catch === 'unknown' ? `unknown (${r.reason ?? ''})` : r.catch)), files: results.map((r) => r.file) };
}

/** Step 4 of admission: the probes of the seeded commit and of the reference commit, together, beside the checks of step 3. */
async function admissionOracle(ctx: Context, input: AdmitInput, state: string, seeded: string, reference: string, work: string): Promise<{ oracle: NonNullable<Admission['oracle']>; reason: string | null }> {
  const { self, pool, repo } = input.run;
  const folder = join(seedDir(repo, input.seed.id), 'oracle');
  const [onSeeded, onReference] = await every([
    pool.work(() => sideProbe(ctx, self, { game: state, commit: seeded, oracle: folder, out: join(work, 'probe-seeded.json') })),
    pool.work(() => sideProbe(ctx, self, { game: state, commit: reference, oracle: folder, out: join(work, 'probe-reference.json') })),
  ]);
  const ok = onSeeded.result === 'fail' && onReference.result === 'pass';
  const reason = ok ? null : `oracle: seeded ${onSeeded.result} (${onSeeded.reason ?? ''}), reference ${onReference.result} (${onReference.reason ?? ''})`;
  return { oracle: { seeded: onSeeded.result, reference: onReference.result }, reason };
}

/** Step 1 of admission: why a base check is not clean for the seed, from the first that is not, or null when each is. */
function baseNotClean(seed: Seed, baseChecks: readonly RegressCheckFile[]): string | null {
  for (const file of baseChecks) {
    const clean = cleanFor(seed.manifest, file);
    if (!clean.clean) return clean.reason;
  }
  return null;
}

/** Admits a seed at `version` (ogw.md `### admission`); a seed that fails a step is `stale` with the reason. */
export async function admitSeed(ctx: Context, input: AdmitInput): Promise<Admission> {
  const { seed } = input;
  const { version } = input.run;
  const unclean = baseNotClean(seed, input.baseChecks);
  if (unclean !== null) return stale(`base fails target: ${unclean}`, { base: input.base });
  const state = await ctx.game(stateGame(seed.manifest.state));
  const applied = await applySeed(ctx, input, state);
  if ('result' in applied) return applied;
  const work = join(await dataDir(ctx), 'regress', `admit-${version}`, seed.id);
  await mkdir(work, { recursive: true });
  const reference = applied.reference;
  // the probes do not wait for the checks of the catch, nor the checks for the probes
  const [{ catches, texts, files }, probed] = await every([
    admissionCatches(ctx, input, state.name, applied.seeded, work),
    reference === null ? Promise.resolve(null) : admissionOracle(ctx, input, state.name, applied.seeded, reference, work),
  ]);
  // what `ogw regress expect` makes the target checks of a seed that the checks catch although no check was known to
  const added = seed.manifest.expect === 'missed' ? addedFailures(files, input.baseChecks) : null;
  const oracle = probed?.oracle ?? null;
  const fields = { base: input.base, seeded: applied.seeded, reference, catch: catches, added, oracle };
  if (catches.some((c) => c !== seed.manifest.expect)) return stale(`not ${seed.manifest.expect}: ${texts.join(', ')}`, fields);
  if (probed !== null && probed.reason !== null) return stale(probed.reason, fields);
  const folder = seedDir(input.run.repo, seed.id);
  await writeFileAtomic(join(folder, `patch-${version}.diff`), await git(state.mainRoot, ['diff', '--binary', input.base, applied.seeded], { env: ctx.env }));
  if (applied.reference !== null) await writeFileAtomic(join(folder, `reference-${version}.diff`), await git(state.mainRoot, ['diff', '--binary', applied.seeded, applied.reference], { env: ctx.env }));
  return { result: 'admitted', ...fields, reason: null, at: Date.now() };
}

export interface StateRefresh {
  state: string;
  from: string;
  /** The `settings` column of the record. */
  settings: string;
  upgrade: string;
  content: string;
  /** The `translation` column of the record. */
  translation: string;
  checks: string;
  failures: string[];
  tag: string | null;
  base: string | null;
  baseChecks: RegressCheckFile[];
  /** The agent jobs of the refresh of this state: its content agent and its translation sub-agents. */
  jobs: { id: string; role: 'content' | 'translation' }[];
}

async function coreVersionAt(ctx: Context, root: string, commit: string): Promise<string> {
  const bytes = await showFile(root, commit, 'settings.json', { env: ctx.env });
  const version = bytes === null ? undefined : (JSON.parse(bytes.toString('utf8')) as { coreVersion?: unknown }).coreVersion;
  return typeof version === 'string' ? version : '0.0.0';
}

/** The content agent of a state whose core was raised: the content input of `### seed-run` 1 with the raised core items. */
async function contentPass(ctx: Context, run: RefreshRun, state: GameRepo, from: string, records: string): Promise<{ ok: boolean; text: string; job: string | null }> {
  const { version } = run;
  const rel = join('records', 'loops', records);
  const items = [`- core version raised to \`${version}\``, ...(await releasedProposals(state, from, version)).map((path) => `- released core proposal \`${path}\``)];
  await writeJsonAtomic(join(state.root, rel, 'defects.json'), { defects: [], previous: null, recordedBy: 'ogw regress refresh' });
  const input = join(state.root, rel, 'content-input-1.md');
  await writeFileAtomic(input, document([['kind', 'completeness'], ['request', items.join('\n')], ['previous record', 'none'], ['defects', 'none']]));
  await commitPaths(state.root, [rel], `regress refresh ${version}: content input`, { env: ctx.env, noVerify: true });
  const ran = await run.pool.work(() => sideAgent(ctx, run.self, { role: 'content', game: state.name, input, seedRun: `${records}:1` }));
  return { ok: ran.status === 'done', text: ran.status === 'done' ? `done (${ran.job ?? ''})` : `${ran.status}: ${ran.reason ?? ''}`, job: ran.job };
}

/**
 * The translation sub-agents of `inputs` (one input file per language) with the seed-run `seedRun` (`<records>:<n>`) in
 * the game `game`, the languages together, each merged once it ends done (`ogw agent merge`, after the merges into the
 * game that came before): their runs and jobs, in the order of `inputs`, and the failure of the first language whose
 * agent did not end done or whose merge failed, as `<language>: <why>`, or null.
 */
export async function translationAgents(ctx: Context, side: Side, pool: RegressPool, game: string, seedRun: string, inputs: readonly { language: string; input: string }[]): Promise<{ runs: FixerRun[]; jobs: string[]; failure: string | null }> {
  const done = await every(
    inputs.map(async ({ language, input }) => {
      const ran = await pool.work(() => sideAgent(ctx, side, { role: 'translation', game, input, seedRun }));
      if (ran.status !== 'done' || ran.job === null) return { ran, failure: `${language}: ${ran.status}: ${ran.reason ?? 'no job'}` };
      const job = ran.job;
      const merge = await pool.merge(game, () => sideMerge(ctx, side, job));
      return { ran, failure: merge === null ? null : `${language}: ${merge}` };
    }),
  );
  return { runs: done.map((d) => d.ran), jobs: done.flatMap((d) => (d.ran.job === null ? [] : [d.ran.job])), failure: done.find((d) => d.failure !== null)?.failure ?? null };
}

/**
 * `### regress refresh` 2: one translation sub-agent per language with missing or stale translations on `main`, the
 * languages together, each merged, as `### seed-run` 2 runs a translation fixer. `text` is the `translation` column of
 * the record.
 */
async function translationPass(ctx: Context, run: RefreshRun, state: GameRepo, records: string): Promise<{ ok: boolean; text: string; jobs: string[] }> {
  const languages = translationLanguages((await placeholderFailures(ctx, state)).map((f) => f.message));
  if (languages.length === 0) return { ok: true, text: 'none', jobs: [] };
  const rel = join('records', 'loops', records);
  const inputs = languages.map((language) => ({ language, input: join(state.root, rel, `translation-input-${language}-${String(Date.now())}.md`) }));
  for (const { language, input } of inputs) await writeFileAtomic(input, `${language}\n`);
  await commitPaths(state.root, [rel], `regress refresh ${run.version}: translation input ${languages.join(', ')}`, { env: ctx.env, noVerify: true });
  const { jobs, failure } = await translationAgents(ctx, run.self, run.pool, state.name, `${records}:1`, inputs);
  if (failure !== null) return { ok: false, text: failure, jobs };
  return { ok: true, text: `done (${jobs.join(', ')})`, jobs };
}

/**
 * A base check kept in the regress repo (ogw.md `### regress refresh` 3): its check file, the harness commit whose tool
 * made it, and the check inputs key of that commit.
 */
interface KeptBaseCheck extends RegressCheckFile {
  harness: string;
  checkInputs: string;
}

/**
 * The base checks kept in the regress repo for `commit` whose check inputs are those of `run`, or null when they are not
 * all there: base checks of other check code, settings or schemas are no evidence for this one.
 */
async function keptBaseChecks(run: RefreshRun, state: string, commit: string): Promise<KeptBaseCheck[] | null> {
  const files: KeptBaseCheck[] = [];
  for (let i = 1; i <= ADMISSION_CHECKS; i++) {
    const file = await readJsonIfExists<Partial<KeptBaseCheck>>(join(baseChecksDir(run.repo, run.version), `${state}-base-${String(i)}.json`));
    if (file?.commit !== commit || file.checkInputs !== run.inputs) return null;
    files.push(file as KeptBaseCheck);
  }
  return files;
}

/**
 * The 3 base checks of the base candidate `commit`, together, kept in the regress repo with the harness commit and the
 * check inputs of `run`: all of their files, or none and why for the first of them that did not run. Whether they are
 * clean for a seed is its admission's (ogw.md `### admission` 1).
 */
async function checkBase(ctx: Context, run: RefreshRun, state: string, commit: string): Promise<{ files: KeptBaseCheck[]; failures: string[]; text: string }> {
  const dir = baseChecksDir(run.repo, run.version);
  const numbers = Array.from({ length: ADMISSION_CHECKS }, (_, i) => i + 1);
  try {
    const checked = await every(
      numbers.map(async (k): Promise<{ k: number; error: string } | { k: number; kept: KeptBaseCheck }> => {
        const out = join(dir, `${state}-base-${String(k)}.json`);
        const one = await run.pool.check(true, () => sideCheck(ctx, run.self, { game: stateGame(state), commit, out, checks: null, performance: true, proof: null }));
        if ('error' in one) return { k, error: one.error };
        const kept: KeptBaseCheck = { commit: one.file.commit, harness: run.self.commit, checkInputs: run.inputs, checks: one.file.checks, fixTestProof: one.file.fixTestProof };
        await writeJsonAtomic(out, kept);
        return { k, kept };
      }),
    );
    const failed = checked.find((c) => 'error' in c);
    if (failed !== undefined && 'error' in failed) return { files: [], failures: [], text: `check ${String(failed.k)}: ${failed.error}` };
    const files = checked.flatMap((c) => ('kept' in c ? [c.kept] : []));
    const failures = [...new Set(files.flatMap((f) => [...keysOf(f)]))];
    return { files, failures, text: `${String(ADMISSION_CHECKS)} checks` };
  } finally {
    // the evidence folders of the base checks stay out of the regress repo
    for (const k of numbers) await rm(join(dir, `${state}-base-${String(k)}`), { recursive: true, force: true });
  }
}

/** Brings one state to `version` and tags its base (ogw.md `### regress refresh` 1 to 4). */
async function refreshState(ctx: Context, run: RefreshRun, state: string, settings: Readonly<Record<string, unknown>>): Promise<StateRefresh> {
  const { version } = run;
  const game = await ctx.game(stateGame(state));
  const tag = baseTag(version);
  const out: StateRefresh = { state, from: '', settings: 'none', upgrade: 'none', content: 'none', translation: 'none', checks: 'none', failures: [], tag: null, base: null, baseChecks: [], jobs: [] };
  if (await tagExists(game.root, tag, { env: ctx.env })) {
    const base = (await revParse(game.root, `refs/tags/${tag}`, { env: ctx.env })) as string;
    out.from = await coreVersionAt(ctx, game.root, base);
    out.tag = tag;
    out.base = base;
    out.baseChecks = (await keptBaseChecks(run, state, base)) ?? [];
    if (out.baseChecks.length === 0) {
      const checked = await checkBase(ctx, run, state, base);
      out.baseChecks = checked.files;
      out.failures = checked.failures;
      out.checks = checked.text;
    } else out.checks = 'kept';
    return out;
  }
  await git(game.root, ['checkout', '--quiet', 'main'], { env: ctx.env });
  out.from = await coreVersionAt(ctx, game.root, 'main');
  // the seed-run records of the refresh of this state, for its content agent and its translation sub-agents
  const records = `refresh-${version}-${String(Date.now())}`;
  if (compareVersions(out.from, version) < 0) {
    const written = await stateSettings(ctx, game, settings, version);
    out.settings = written.text;
    if (!written.ok) return out;
    const upgraded = await run.pool.work(() => upgradeCore(ctx, game.name, version));
    out.upgrade = upgraded.ok ? `to ${version}` : `failed: ${upgraded.text.split('\n')[0] ?? ''}`;
    if (!upgraded.ok) return out;
    const content = await contentPass(ctx, run, game, out.from, records);
    out.content = content.text;
    if (content.job !== null) out.jobs.push({ id: content.job, role: 'content' });
    if (!content.ok) return out;
  }
  const translated = await translationPass(ctx, run, game, records);
  out.translation = translated.text;
  out.jobs.push(...translated.jobs.map((id) => ({ id, role: 'translation' as const })));
  if (!translated.ok) return out;
  const commit = await head(game.root, { env: ctx.env });
  const checked = await checkBase(ctx, run, state, commit);
  out.checks = checked.text;
  out.failures = checked.failures;
  out.baseChecks = checked.files;
  if (checked.files.length === 0) return out;
  await git(game.root, ['tag', tag, commit], { env: ctx.env });
  out.tag = tag;
  out.base = commit;
  return out;
}

/** Why a state has no base: the columns of its refresh up to the base checks, as the stale reason and the output give it. */
export function untaggedWhy(state: StateRefresh): string {
  return [state.settings, state.upgrade, state.content, state.translation, state.checks].join('; ');
}

export interface SeedRefresh {
  seed: string;
  admission: Admission;
  /** What the seed agent of the seed came to (`### seed agent`); absent or null when none ran. */
  rebase?: SeedRebase | null;
}

/** `records/refresh-<v>.md`. */
export async function refreshRecord(ctx: Context, states: readonly StateRefresh[], seeds: readonly SeedRefresh[]): Promise<string> {
  const jobs: JobRecord[] = [];
  const seedJobs = seeds.flatMap((s) => (s.rebase?.job === null || s.rebase?.job === undefined ? [] : [{ id: s.rebase.job, role: 'seed' as const }]));
  for (const { id, role } of [...states.flatMap((s) => s.jobs), ...seedJobs]) jobs.push({ meta: { role, usage: (await jobFacts(ctx, id)).usage ?? undefined } } as unknown as JobRecord);
  return document([
    ['states', states.length === 0 ? 'none' : renderTable(['state', 'from', 'settings', 'upgrade', 'content job', 'translation', 'base checks', 'base failures', 'tag'], states.map((s) => [s.state, s.from, s.settings, s.upgrade, s.content, s.translation, s.checks, s.failures.join(', ') || 'none', s.tag ?? 'none']))],
    ['seeds', seeds.length === 0 ? 'none' : renderTable(['seed', 'result', 'reason', 'catch', 'oracle', 'rebase'], seeds.map((s) => [s.seed, s.admission.result, s.admission.reason ?? 'none', s.admission.catch.join(', ') || 'none', s.admission.oracle === null ? 'none' : `seeded ${s.admission.oracle.seeded}, reference ${s.admission.oracle.reference}`, rebaseText(s.rebase)]))],
    ['cost', renderCost(costRows(jobs, true))],
  ]);
}

/**
 * Refreshes the states of `seeds` at `version` and admits the seeds (`### regress refresh`), each seed once the refresh of
 * its state has ended. With `rebase` (`ogw regress refresh`), a seed whose admission ends stale for a reason that goes to
 * the seed agent is rebased then (`### seed agent`). The paths it wrote in the regress repo, for the commit.
 */
export async function refresh(ctx: Context, repo: string, self: Side, version: string, seeds: readonly Seed[], onlyStates: readonly string[] | null): Promise<{ paths: string[]; states: StateRefresh[]; seeds: SeedRefresh[] }> {
  const entries = await readStates(repo);
  const states = onlyStates ?? entries.map((s) => s.state);
  const ws = await ctx.workspace();
  const run: RefreshRun = { repo, self, version, inputs: await checkInputs(ctx, ws.harness, self.commit), pool: regressPool((await ctx.settings()).regress.parallel) };
  const refreshing = new Map(states.map((state) => [state, refreshState(ctx, run, state, entries.find((e) => e.state === state)?.settings ?? {})]));
  const admitting = seeds.map(async (seed): Promise<SeedRefresh> => {
    const state = await refreshing.get(seed.manifest.state);
    if (state === undefined || state.base === null || state.tag === null || state.baseChecks.length === 0) {
      return { seed: seed.id, admission: stale(`base fails target: ${seed.manifest.state} ${state === undefined ? 'is not a state' : untaggedWhy(state)}`) };
    }
    const input = { run, seed, base: state.base, baseChecks: state.baseChecks };
    const admission = await admitSeed(ctx, input);
    // `ogw regress seed` and `ogw regress expect` admit as they are; the refresh rebases when its seed's admission ends
    if (onlyStates !== null || !rebasable(admission)) return { seed: seed.id, admission };
    return { seed: seed.id, ...(await rebaseSeed(ctx, { run, tag: state.tag, admit: () => admitSeed(ctx, input) }, seed, admission)) };
  });
  const [refreshed, results] = await every([every([...refreshing.values()]), every(admitting)]);
  const paths: string[] = [];
  for (const r of results) {
    const path = admissionPath(repo, r.seed, version);
    await writeJsonAtomic(path, r.admission);
    paths.push(join('seeds', r.seed));
  }
  const record = join('records', `refresh-${version}.md`);
  if (onlyStates === null) {
    await writeFileAtomic(join(repo, record), await refreshRecord(ctx, refreshed, results));
    paths.push(record);
  }
  if (exists(baseChecksDir(repo, version))) paths.push(join('records', `refresh-${version}`));
  return { paths, states: refreshed, seeds: results };
}
