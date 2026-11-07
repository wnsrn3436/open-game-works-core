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
import { jobFacts, sideAgent, sideCheck, sideMerge, sideProbe, type Side } from './side.ts';
import { checkGate, pooled, type CheckGate } from './pool.ts';

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
  return { result: 'stale', base: null, seeded: null, reference: null, catch: [], oracle: null, reason, at: Date.now(), ...fields };
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

export interface AdmitInput {
  repo: string;
  seed: Seed;
  version: string;
  base: string;
  baseChecks: readonly RegressCheckFile[];
  /** The side whose tool checks: the harness repo itself. */
  self: Side;
  /** The gate of the checks of the command. */
  gate: CheckGate;
}

/** Step 1 of admission: the seeded commit, and with `oracle` the reference commit; a stale admission when they do not apply. */
async function applySeed(ctx: Context, input: AdmitInput, state: GameRepo): Promise<{ seeded: string; reference: string | null } | Admission> {
  const { seed, version } = input;
  const patch = await latestPatch(input.repo, seed.id, version, 'patch');
  if (patch === null) return stale(`patch does not apply: no patch-<version>.diff at or below ${version}`, { base: input.base });
  const seeded = await applyOn(ctx, state, input.base, `seed/${seed.id}-${version}`, patch.path, seed.manifest.regenerate, `seed ${seed.id} at ${version}`);
  if ('error' in seeded) return stale(seeded.error, { base: input.base });
  if (!seed.manifest.oracle) return { seeded: seeded.commit, reference: null };
  const fix = await latestPatch(input.repo, seed.id, version, 'reference');
  if (fix === null) return stale(`oracle: no reference-<version>.diff at or below ${version}`, { base: input.base, seeded: seeded.commit });
  const applied = await applyOn(ctx, state, seeded.commit, `reference/${seed.id}-${version}`, fix.path, seed.manifest.regenerate, `reference fix of ${seed.id} at ${version}`);
  if ('error' in applied) return stale(`oracle: the reference fix does not apply: ${applied.error}`, { base: input.base, seeded: seeded.commit });
  return { seeded: seeded.commit, reference: applied.commit };
}

/**
 * Step 2 of admission: the catch of each of the checks of the seeded commit with the base check of the same number,
 * and its text for the stale reason: an `unknown` catch with why (the error of a check that did not run, or the reason
 * of the catch).
 */
async function admissionCatches(ctx: Context, input: AdmitInput, state: string, seeded: string, work: string): Promise<{ catches: string[]; texts: string[] }> {
  const manifest = input.seed.manifest;
  const catches: string[] = [];
  const texts: string[] = [];
  for (let i = 0; i < ADMISSION_CHECKS; i++) {
    const out = join(work, `seeded-${String(i + 1)}.json`);
    const checks = manifest.expect === 'caught' ? targetChecks(manifest) : null;
    const checked = await input.gate.run(manifest.performance, () => sideCheck(ctx, input.self, { game: state, commit: seeded, out, checks, performance: manifest.performance, proof: null }));
    const base = input.baseChecks[i] ?? input.baseChecks[0];
    const result = !('file' in checked) ? { catch: 'unknown', reason: checked.error } : base === undefined ? { catch: 'unknown', reason: 'no base check' } : catchOf(manifest, base, checked.file);
    catches.push(result.catch);
    texts.push(result.catch === 'unknown' ? `unknown (${result.reason ?? ''})` : result.catch);
  }
  return { catches, texts };
}

/** Step 3 of admission: the probe of the seeded commit and of the reference commit. */
async function admissionOracle(ctx: Context, input: AdmitInput, state: string, seeded: string, reference: string, work: string): Promise<{ oracle: NonNullable<Admission['oracle']>; reason: string | null }> {
  const folder = join(seedDir(input.repo, input.seed.id), 'oracle');
  const onSeeded = await sideProbe(ctx, input.self, { game: state, commit: seeded, oracle: folder, out: join(work, 'probe-seeded.json') });
  const onReference = await sideProbe(ctx, input.self, { game: state, commit: reference, oracle: folder, out: join(work, 'probe-reference.json') });
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
  const { seed, version } = input;
  const unclean = baseNotClean(seed, input.baseChecks);
  if (unclean !== null) return stale(`base fails target: ${unclean}`, { base: input.base });
  const state = await ctx.game(stateGame(seed.manifest.state));
  const applied = await applySeed(ctx, input, state);
  if ('result' in applied) return applied;
  const work = join(await dataDir(ctx), 'regress', `admit-${version}`, seed.id);
  await mkdir(work, { recursive: true });
  const { catches, texts } = await admissionCatches(ctx, input, state.name, applied.seeded, work);
  const fields = { base: input.base, seeded: applied.seeded, reference: applied.reference, catch: catches };
  if (catches.some((c) => c !== seed.manifest.expect)) return stale(`not ${seed.manifest.expect}: ${texts.join(', ')}`, fields);
  let oracle: Admission['oracle'] = null;
  if (applied.reference !== null) {
    const probed = await admissionOracle(ctx, input, state.name, applied.seeded, applied.reference, work);
    oracle = probed.oracle;
    if (probed.reason !== null) return stale(probed.reason, { ...fields, oracle });
  }
  const folder = seedDir(input.repo, seed.id);
  await writeFileAtomic(join(folder, `patch-${version}.diff`), await git(state.mainRoot, ['diff', '--binary', input.base, applied.seeded], { env: ctx.env }));
  if (applied.reference !== null) await writeFileAtomic(join(folder, `reference-${version}.diff`), await git(state.mainRoot, ['diff', '--binary', applied.seeded, applied.reference], { env: ctx.env }));
  return { result: 'admitted', ...fields, oracle, reason: null, at: Date.now() };
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
async function contentPass(ctx: Context, self: Side, state: GameRepo, from: string, version: string, records: string): Promise<{ ok: boolean; text: string; job: string | null }> {
  const rel = join('records', 'loops', records);
  const items = [`- core version raised to \`${version}\``, ...(await releasedProposals(state, from, version)).map((path) => `- released core proposal \`${path}\``)];
  await writeJsonAtomic(join(state.root, rel, 'defects.json'), { defects: [], previous: null, recordedBy: 'ogw regress refresh' });
  const input = join(state.root, rel, 'content-input-1.md');
  await writeFileAtomic(input, document([['kind', 'completeness'], ['request', items.join('\n')], ['previous record', 'none'], ['defects', 'none']]));
  await commitPaths(state.root, [rel], `regress refresh ${version}: content input`, { env: ctx.env, noVerify: true });
  const ran = await sideAgent(ctx, self, { role: 'content', game: state.name, input, seedRun: `${records}:1` });
  return { ok: ran.status === 'done', text: ran.status === 'done' ? `done (${ran.job ?? ''})` : `${ran.status}: ${ran.reason ?? ''}`, job: ran.job };
}

/**
 * `### regress refresh` 2: one translation sub-agent per language with missing or stale translations on `main`, one after
 * another, each merged, as `### seed-run` 2 runs a translation fixer. `text` is the `translation` column of the record.
 */
async function translationPass(ctx: Context, self: Side, state: GameRepo, version: string, records: string): Promise<{ ok: boolean; text: string; jobs: string[] }> {
  const languages = translationLanguages((await placeholderFailures(ctx, state)).map((f) => f.message));
  const rel = join('records', 'loops', records);
  const jobs: string[] = [];
  for (const language of languages) {
    const input = join(state.root, rel, `translation-input-${language}-${String(Date.now())}.md`);
    await writeFileAtomic(input, `${language}\n`);
    await commitPaths(state.root, [rel], `regress refresh ${version}: translation input ${language}`, { env: ctx.env, noVerify: true });
    const ran = await sideAgent(ctx, self, { role: 'translation', game: state.name, input, seedRun: `${records}:1` });
    if (ran.job !== null) jobs.push(ran.job);
    if (ran.status !== 'done' || ran.job === null) return { ok: false, text: `${language}: ${ran.status}: ${ran.reason ?? 'no job'}`, jobs };
    const merge = await sideMerge(ctx, self, ran.job);
    if (merge !== null) return { ok: false, text: `${language}: ${merge}`, jobs };
  }
  return { ok: true, text: jobs.length === 0 ? 'none' : `done (${jobs.join(', ')})`, jobs };
}

/** A base check kept in the regress repo (ogw.md `### regress refresh` 3): its check file and the harness commit that made it. */
interface KeptBaseCheck extends RegressCheckFile {
  harness: string;
}

/**
 * The base checks kept in the regress repo for `commit` that the tool of harness commit `harness` made, or null when
 * they are not all there: base checks of other check code are no evidence for this one.
 */
async function keptBaseChecks(repo: string, version: string, state: string, commit: string, harness: string): Promise<KeptBaseCheck[] | null> {
  const files: KeptBaseCheck[] = [];
  for (let i = 1; i <= ADMISSION_CHECKS; i++) {
    const file = await readJsonIfExists<Partial<KeptBaseCheck>>(join(baseChecksDir(repo, version), `${state}-base-${String(i)}.json`));
    if (file?.commit !== commit || file.harness !== harness) return null;
    files.push(file as KeptBaseCheck);
  }
  return files;
}

/**
 * The 3 base checks of the base candidate `commit`, kept in the regress repo with the harness commit of `self`: all of
 * their files, or none and why when one of them did not run. Whether they are clean for a seed is its admission's
 * (ogw.md `### admission` 1).
 */
async function checkBase(ctx: Context, repo: string, self: Side, gate: CheckGate, state: string, commit: string, version: string): Promise<{ files: KeptBaseCheck[]; failures: string[]; text: string }> {
  const files: KeptBaseCheck[] = [];
  for (let i = 1; i <= ADMISSION_CHECKS; i++) {
    const out = join(baseChecksDir(repo, version), `${state}-base-${String(i)}.json`);
    const checked = await gate.run(true, () => sideCheck(ctx, self, { game: stateGame(state), commit, out, checks: null, performance: true, proof: null }));
    if ('error' in checked) return { files: [], failures: [], text: `check ${String(i)}: ${checked.error}` };
    const kept: KeptBaseCheck = { commit: checked.file.commit, harness: self.commit, checks: checked.file.checks, fixTestProof: checked.file.fixTestProof };
    await writeJsonAtomic(out, kept);
    files.push(kept);
  }
  // the evidence folders of the base checks stay out of the regress repo
  for (let i = 1; i <= ADMISSION_CHECKS; i++) await rm(join(baseChecksDir(repo, version), `${state}-base-${String(i)}`), { recursive: true, force: true });
  const failures = [...new Set(files.flatMap((f) => [...keysOf(f)]))];
  return { files, failures, text: `${String(ADMISSION_CHECKS)} checks` };
}

/** Brings one state to `version` and tags its base (ogw.md `### regress refresh` 1 to 4). */
export async function refreshState(ctx: Context, repo: string, self: Side, gate: CheckGate, state: string, version: string, settings: Readonly<Record<string, unknown>>): Promise<StateRefresh> {
  const game = await ctx.game(stateGame(state));
  const tag = baseTag(version);
  const out: StateRefresh = { state, from: '', settings: 'none', upgrade: 'none', content: 'none', translation: 'none', checks: 'none', failures: [], tag: null, base: null, baseChecks: [], jobs: [] };
  if (await tagExists(game.root, tag, { env: ctx.env })) {
    const base = (await revParse(game.root, `refs/tags/${tag}`, { env: ctx.env })) as string;
    out.from = await coreVersionAt(ctx, game.root, base);
    out.tag = tag;
    out.base = base;
    out.baseChecks = (await keptBaseChecks(repo, version, state, base, self.commit)) ?? [];
    if (out.baseChecks.length === 0) {
      const checked = await checkBase(ctx, repo, self, gate, state, base, version);
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
    const upgraded = await upgradeCore(ctx, game.name, version);
    out.upgrade = upgraded.ok ? `to ${version}` : `failed: ${upgraded.text.split('\n')[0] ?? ''}`;
    if (!upgraded.ok) return out;
    const content = await contentPass(ctx, self, game, out.from, version, records);
    out.content = content.text;
    if (content.job !== null) out.jobs.push({ id: content.job, role: 'content' });
    if (!content.ok) return out;
  }
  const translated = await translationPass(ctx, self, game, version, records);
  out.translation = translated.text;
  out.jobs.push(...translated.jobs.map((id) => ({ id, role: 'translation' as const })));
  if (!translated.ok) return out;
  const commit = await head(game.root, { env: ctx.env });
  const checked = await checkBase(ctx, repo, self, gate, state, commit, version);
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
}

/** `records/refresh-<v>.md`. */
export async function refreshRecord(ctx: Context, states: readonly StateRefresh[], seeds: readonly SeedRefresh[]): Promise<string> {
  const jobs: JobRecord[] = [];
  for (const { id, role } of states.flatMap((s) => s.jobs)) jobs.push({ meta: { role, usage: (await jobFacts(ctx, id)).usage ?? undefined } } as unknown as JobRecord);
  return document([
    ['states', states.length === 0 ? 'none' : renderTable(['state', 'from', 'settings', 'upgrade', 'content job', 'translation', 'base checks', 'base failures', 'tag'], states.map((s) => [s.state, s.from, s.settings, s.upgrade, s.content, s.translation, s.checks, s.failures.join(', ') || 'none', s.tag ?? 'none']))],
    ['seeds', seeds.length === 0 ? 'none' : renderTable(['seed', 'result', 'reason', 'catch', 'oracle'], seeds.map((s) => [s.seed, s.admission.result, s.admission.reason ?? 'none', s.admission.catch.join(', ') || 'none', s.admission.oracle === null ? 'none' : `seeded ${s.admission.oracle.seeded}, reference ${s.admission.oracle.reference}`]))],
    ['cost', renderCost(costRows(jobs, true))],
  ]);
}

/**
 * The admission of each seed on the base of its refreshed state, or why its state has none: the seeds of one state one
 * after another, and the states together, at most `parallel` at a time (`### regress refresh`). In the order of `seeds`.
 */
async function admitSeeds(ctx: Context, repo: string, self: Side, gate: CheckGate, version: string, seeds: readonly Seed[], refreshed: readonly StateRefresh[], parallel: number): Promise<SeedRefresh[]> {
  const admit = async (seed: Seed): Promise<SeedRefresh> => {
    const state = refreshed.find((s) => s.state === seed.manifest.state);
    if (state === undefined || state.base === null || state.baseChecks.length === 0) {
      return { seed: seed.id, admission: stale(`base fails target: ${seed.manifest.state} ${state === undefined ? 'is not a state' : untaggedWhy(state)}`) };
    }
    return { seed: seed.id, admission: await admitSeed(ctx, { repo, seed, version, base: state.base, baseChecks: state.baseChecks, self, gate }) };
  };
  const groups = [...new Set(seeds.map((s) => s.manifest.state))].map((state) => seeds.filter((s) => s.manifest.state === state));
  const admitted = await pooled(groups, parallel, async (group) => {
    const out: SeedRefresh[] = [];
    for (const seed of group) out.push(await admit(seed));
    return out;
  });
  const byId = new Map(admitted.flat().map((r) => [r.seed, r]));
  return seeds.map((seed) => byId.get(seed.id) as SeedRefresh);
}

/**
 * Refreshes the states of `seeds` at `version` and admits the seeds (`### regress refresh`): the paths it wrote in the
 * regress repo, for the commit.
 */
export async function refresh(ctx: Context, repo: string, self: Side, version: string, seeds: readonly Seed[], onlyStates: readonly string[] | null): Promise<{ paths: string[]; states: StateRefresh[]; seeds: SeedRefresh[] }> {
  const entries = await readStates(repo);
  const states = onlyStates ?? entries.map((s) => s.state);
  const parallel = (await ctx.settings()).regress.parallel;
  const gate = checkGate();
  const refreshed = await pooled(states, parallel, (state) =>
    refreshState(ctx, repo, self, gate, state, version, entries.find((e) => e.state === state)?.settings ?? {}),
  );
  const results = await admitSeeds(ctx, repo, self, gate, version, seeds, refreshed, parallel);
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
