/** `ogw regress run` (ogw.md `### regress run` of `## regress`): the sides, the catch, the fix and the report. */
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import { revParse } from '../../../lib/git.ts';
import type { AgentSettings } from '../../../lib/settings.ts';
import { dataDir } from '../../env/lib/host.ts';
import { makeCopyRepo, registryCommit } from './copy.ts';
import { checkGate, pooled, type CheckGate } from './pool.ts';
import { catchOf, type CatchResult, type RegressCheckFile } from './keys.ts';
import { commitRegress, fixGame, listSeeds, readAdmission, readStates, seedDir, stateGame, type Admission, type Seed } from './repo.ts';
import { renderReport, type CatchLine, type RunData, type SeedLine } from './report.ts';
import { runSeedRun, seedRunId, type SeedRunResult } from './seed-run.ts';
import { makeSide, removeSide, requireSameCore, sideCheck, type Side, type SideName, type SideSpec } from './side.ts';

export interface RunOptions {
  before: SideSpec;
  after: SideSpec;
  repeats: number;
  seeds: string[] | null;
  catchOnly: boolean;
}

/** `<role>=<cli>/<model>/<effort>` of `--before-agent` and `--after-agent`. */
export function parseAgentOverride(value: string): [string, AgentSettings] {
  const match = /^([a-z-]+)=([a-z-]+)\/([^/]+)\/([^/]+)$/.exec(value);
  if (match === null) throw new OgwError(`an agent override is <role>=<cli>/<model>/<effort>: ${value}`);
  return [match[1] as string, { cli: match[2] as AgentSettings['cli'], model: match[3] as string, effort: match[4] as string }];
}


interface Admitted {
  seed: Seed;
  admission: Admission;
}

interface SideCatch {
  base: Map<string, { file: RegressCheckFile; path: string } | { error: string }>;
  seeded: Map<string, { file: RegressCheckFile; path: string } | { error: string }>;
  catches: Map<string, CatchResult>;
}

/**
 * The catch of each admitted seed by one side (`### regress run` 2), with the second check of a catch that is not its
 * `expect`: the checks of one state one after another, its base first, and the states together, at most `parallel`, a
 * check with performance alone (`gate`).
 */
async function catchPhase(ctx: Context, side: Side, admitted: readonly Admitted[], folder: string, parallel: number, gate: CheckGate): Promise<SideCatch> {
  const out: SideCatch = { base: new Map(), seeded: new Map(), catches: new Map() };
  const catchOfSeed = async ({ seed, admission }: Admitted): Promise<void> => {
    const base = out.base.get(seed.manifest.state);
    const once = async (attempt: number): Promise<CatchResult> => {
      const path = join(folder, attempt === 1 ? `${seed.id}.json` : `${seed.id}-${String(attempt)}.json`);
      const performance = seed.manifest.performance;
      const checked = await gate.run(performance, () => sideCheck(ctx, side, { game: stateGame(seed.manifest.state), commit: admission.seeded as string, out: path, checks: null, performance, proof: null }));
      if (!('file' in checked)) return { catch: 'unknown', reason: checked.error, collateral: [], pipeline: null, matched: null };
      out.seeded.set(seed.id, { file: checked.file, path });
      if (base === undefined || !('file' in base)) return { catch: 'unknown', reason: `the base check of ${seed.manifest.state}: ${base === undefined ? 'none' : base.error}`, collateral: [], pipeline: null, matched: null };
      return catchOf(seed.manifest, base.file, checked.file);
    };
    const first = await once(1);
    out.catches.set(seed.id, first.catch === seed.manifest.expect ? first : await once(2));
  };
  const states = [...new Map(admitted.map((a) => [a.seed.manifest.state, a.admission.base as string])).entries()];
  await pooled(states, parallel, async ([state, base]) => {
    const path = join(folder, `${state}-base.json`);
    const checked = await gate.run(true, () => sideCheck(ctx, side, { game: stateGame(state), commit: base, out: path, checks: null, performance: true, proof: null }));
    out.base.set(state, 'file' in checked ? { file: checked.file, path } : checked);
    for (const one of admitted.filter((a) => a.seed.manifest.state === state)) await catchOfSeed(one);
  });
  return out;
}

/** The seed-run plan of one seed: in repeat k, the before side first for odd k and the after side first for even k. */
export function seedRunOrder(repeats: number): { side: SideName; repeat: number }[] {
  const order: { side: SideName; repeat: number }[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const sides: SideName[] = repeat % 2 === 1 ? ['before', 'after'] : ['after', 'before'];
    for (const side of sides) order.push({ side, repeat });
  }
  return order;
}

/** Removes the fix repos and their worktree folders: those of this run, and those an ended run left. */
async function removeFixRepos(ctx: Context): Promise<void> {
  const ws = await ctx.workspace();
  for (const parent of [ws.games, ws.worktrees]) {
    if (!exists(parent)) continue;
    for (const name of await readdir(parent)) if (/^ogw-regress-fix-\d+$/.test(name)) await rm(join(parent, name), { recursive: true, force: true });
  }
}

interface FixPlan {
  admitted: Admitted;
  game: string;
  root: string;
  roots: { main: string; registry: string | null };
}

/** The fix repos, all made before any fixer starts (`### regress run` 3). */
async function makeFixRepos(ctx: Context, plans: readonly Admitted[]): Promise<FixPlan[]> {
  const ws = await ctx.workspace();
  await removeFixRepos(ctx);
  const out: FixPlan[] = [];
  for (const [index, admitted] of plans.entries()) {
    const game = fixGame(index + 1);
    const state = join(ws.games, stateGame(admitted.seed.manifest.state));
    const registry = await registryCommit(ctx, state);
    const main = await makeCopyRepo(ctx, game, { repo: state, commit: admitted.admission.seeded as string, registry }, { kind: 'fix', state: admitted.seed.manifest.state }, `fix repo ${String(index + 1)}`);
    // the worktree folder exists before any fixer starts, so the sandbox of the other fixers blocks the worktrees made in it
    await mkdir(join(ws.worktrees, game), { recursive: true });
    out.push({ admitted, game, root: join(ws.games, game), roots: { main, registry: await revParse(join(ws.games, game), 'refs/heads/id-registry', { env: ctx.env }) } });
  }
  return out;
}

export interface RunOutcome {
  report: string;
  difference: string[];
  exitCode: number;
}

/** The admitted seeds at `version` and the seed lines of the report. */
async function seedsAt(repo: string, version: string, only: readonly string[] | null): Promise<{ lines: SeedLine[]; admitted: Admitted[] }> {
  const all = await listSeeds(repo);
  if (only !== null) {
    const missing = only.filter((id) => !all.some((s) => s.id === id));
    if (missing.length > 0) throw new OgwError(`no seed ${missing.join(', ')} in ${repo}`);
  }
  const states = new Set((await readStates(repo)).map((s) => s.state));
  const lines: SeedLine[] = [];
  const admitted: Admitted[] = [];
  for (const seed of all.filter((s) => only === null || only.includes(s.id))) {
    const admission = await readAdmission(repo, seed.id, version);
    let unknown: string | null = null;
    if (!states.has(seed.manifest.state)) unknown = `state ${seed.manifest.state} is not in states.json`;
    else if (admission === null) unknown = `not admitted at ${version}: run ogw regress refresh`;
    else if (admission.result !== 'admitted') unknown = `stale at ${version}: ${admission.reason ?? ''}`;
    lines.push({ id: seed.id, state: seed.manifest.state, expect: seed.manifest.expect, unknown });
    if (unknown === null && admission !== null) admitted.push({ seed, admission });
  }
  return { lines, admitted };
}

/** The fix phase (`### regress run` 4): the seed-runs of each seed in its fix repo, the seeds with `performance` last and alone. */
async function fixPhase(ctx: Context, runMs: number, sides: Record<SideName, Side>, plans: readonly FixPlan[], after: SideCatch, folder: string, repo: string, repeats: number): Promise<SeedRunResult[]> {
  const settings = await ctx.settings();
  let k = 0;
  const runSeed = async (plan: FixPlan): Promise<SeedRunResult[]> => {
    const { seed } = plan.admitted;
    const base = after.base.get(seed.manifest.state);
    const seeded = after.seeded.get(seed.id);
    const catchResult = after.catches.get(seed.id);
    if (base === undefined || !('file' in base) || seeded === undefined || !('file' in seeded)) return [];
    const results: SeedRunResult[] = [];
    for (const step of seedRunOrder(repeats)) {
      k++;
      const id = seedRunId(seed.id, step.side, step.repeat);
      results.push(
        await runSeedRun(ctx, {
          runMs,
          k,
          seed,
          side: sides[step.side],
          after: sides.after,
          repeat: step.repeat,
          fix: { game: plan.game, root: plan.root, roots: plan.roots },
          catchAfter: { base: base.file, seeded: seeded.file, seededPath: seeded.path, matched: catchResult?.matched ?? null },
          oracle: seed.manifest.oracle ? join(seedDir(repo, seed.id), 'oracle') : null,
          work: join(folder, 'fix', id),
          cap: settings.loopStop.repeatedDefect,
          diff: join(repo, 'records', 'runs', String(runMs), `${id}.diff`),
        }),
      );
    }
    return results;
  };
  const quiet = plans.filter((p) => !p.admitted.seed.manifest.performance);
  const loud = plans.filter((p) => p.admitted.seed.manifest.performance);
  const first = (await pooled(quiet, settings.regress.parallel, runSeed)).flat();
  const last = (await pooled(loud, 1, runSeed)).flat();
  return [...first, ...last];
}

/** Copies the check files (not the evidence) of the run into `records/runs/<unix ms>/checks/` of the regress repo. */
async function copyCheckFiles(from: string, to: string): Promise<void> {
  if (!exists(from)) return;
  for (const entry of await readdir(from, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const source = join(entry.parentPath, entry.name);
    const target = join(to, relative(from, source));
    await mkdir(join(target, '..'), { recursive: true });
    await cp(source, target);
  }
}

/** `ogw regress run`: the report path, the lines of `## difference` and the exit code. */
export async function regressRun(ctx: Context, repo: string, options: RunOptions): Promise<RunOutcome> {
  const runMs = Date.now();
  const settings = await ctx.settings();
  const folder = join(await dataDir(ctx), 'regress', String(runMs));
  const sides: Record<SideName, Side> = { before: await makeSide(ctx, options.before), after: await makeSide(ctx, options.after) };
  const data: RunData = { run: runMs, catchOnly: options.catchOnly, sides: [sides.before, sides.after], seeds: [], catches: [], seedRuns: [] };
  try {
    if (sides.before.unknown === null && sides.after.unknown === null) {
      const version = requireSameCore(sides.before.info as NonNullable<Side['info']>, sides.after.info as NonNullable<Side['info']>);
      const { lines, admitted } = await seedsAt(repo, version, options.seeds);
      data.seeds = lines;
      // the fix phase needs no gate: its checks with performance are those of the seeds with performance, which run alone
      const gate = checkGate();
      const caught = {
        before: await catchPhase(ctx, sides.before, admitted, join(folder, 'catch', 'before'), settings.regress.parallel, gate),
        after: await catchPhase(ctx, sides.after, admitted, join(folder, 'catch', 'after'), settings.regress.parallel, gate),
      };
      data.catches = admitted.map((a): CatchLine => ({ seed: a.seed.id, before: caught.before.catches.get(a.seed.id) ?? null, after: caught.after.catches.get(a.seed.id) ?? null }));
      if (!options.catchOnly) {
        const fixable = admitted.filter((a) => a.seed.manifest.fixer !== 'none' && caught.after.catches.get(a.seed.id)?.catch !== 'unknown');
        try {
          const plans = await makeFixRepos(ctx, fixable);
          data.seedRuns = await fixPhase(ctx, runMs, sides, plans, caught.after, folder, repo, options.repeats);
        } finally {
          await removeFixRepos(ctx);
        }
      }
    }
  } finally {
    await removeSide(ctx, sides.before);
    await removeSide(ctx, sides.after);
  }
  const records = join('records', 'runs', String(runMs));
  await mkdir(join(repo, records), { recursive: true });
  await copyCheckFiles(folder, join(repo, records, 'checks'));
  await writeJsonAtomic(join(repo, records, 'run.json'), data);
  const { text, difference } = renderReport(data, settings.regress.permutations, settings.regress.level);
  const report = `${records}.md`;
  await writeFileAtomic(join(repo, report), text);
  await commitRegress(ctx, repo, [records, report], `regress run ${String(runMs)}`);
  const unknownSide = data.sides.some((s) => s.unknown !== null);
  return { report: join(repo, report), difference, exitCode: unknownSide ? 1 : 0 };
}
