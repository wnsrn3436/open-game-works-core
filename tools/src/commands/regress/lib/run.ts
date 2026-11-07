/** `ogw regress run` (ogw.md `### regress run` of `## regress`): the sides, the catch, the fix and the report. */
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import type { AgentSettings } from '../../../lib/settings.ts';
import { dataDir } from '../../env/lib/host.ts';
import { canCloneFolders, cloneCopyRepo, makeCopyRepo, registryCommit } from './copy.ts';
import { pooled } from '../../../lib/pool.ts';
import { every, limiter, regressPool, type RegressPool } from './pool.ts';
import { catchOf, type CatchResult, type RegressCheckFile } from './keys.ts';
import { commitRegress, fixGame, listSeeds, readAdmission, readStates, seedDir, stateGame, type Admission, type Seed } from './repo.ts';
import { renderReport, type CatchLine, type RunData, type SeedLine } from './report.ts';
import { runSeedRun, seedRunId, type SeedRunInput, type SeedRunResult } from './seed-run.ts';
import { makeSide, removeSide, requireSameCore, sideCheck, type Side, type SideInfo, type SideName, type SideSpec } from './side.ts';

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

type Checked = { file: RegressCheckFile; path: string } | { error: string };

interface SideCatch {
  base: Map<string, Checked>;
  seeded: Map<string, Checked>;
  catches: Map<string, CatchResult>;
}

/** The catch of one side while it runs: what has ended so far, the end of the catch of each seed, and the end of all. */
interface Catching {
  caught: SideCatch;
  /** By seed id: the end of the catch of that seed, once its seeded checks and the check of the base of its state ended. */
  seeds: Map<string, Promise<void>>;
  all: Promise<SideCatch>;
  /** Whether `all` failed. */
  failed: () => boolean;
}

/**
 * The catch of each admitted seed by one side (`### regress run` 2): the check of the base of each state and the first
 * check of each seeded commit together, the catch of a seed once the check of the base of its state has ended, and the
 * second check of a catch that is not its `expect`.
 */
function catchPhase(ctx: Context, side: Side, admitted: readonly Admitted[], folder: string, pool: RegressPool): Catching {
  const out: SideCatch = { base: new Map(), seeded: new Map(), catches: new Map() };
  const bases = new Map<string, Promise<Checked>>();
  // the base checks come first to the pool: every catch waits for one
  for (const { seed, admission } of admitted) {
    const state = seed.manifest.state;
    if (bases.has(state)) continue;
    const path = join(folder, `${state}-base.json`);
    bases.set(
      state,
      pool.check(true, () => sideCheck(ctx, side, { game: stateGame(state), commit: admission.base as string, out: path, checks: null, performance: true, proof: null })).then((checked): Checked => {
        const result = 'file' in checked ? { file: checked.file, path } : checked;
        out.base.set(state, result);
        return result;
      }),
    );
  }
  const catchOfSeed = async ({ seed, admission }: Admitted): Promise<void> => {
    const once = async (attempt: number): Promise<CatchResult> => {
      const path = join(folder, attempt === 1 ? `${seed.id}.json` : `${seed.id}-${String(attempt)}.json`);
      const performance = seed.manifest.performance;
      const checked = await pool.check(performance, () => sideCheck(ctx, side, { game: stateGame(seed.manifest.state), commit: admission.seeded as string, out: path, checks: null, performance, proof: null }));
      if (!('file' in checked)) return { catch: 'unknown', reason: checked.error, collateral: [], pipeline: null, matched: null };
      out.seeded.set(seed.id, { file: checked.file, path });
      const base = await bases.get(seed.manifest.state);
      if (base === undefined || !('file' in base)) return { catch: 'unknown', reason: `the base check of ${seed.manifest.state}: ${base === undefined ? 'none' : base.error}`, collateral: [], pipeline: null, matched: null };
      return catchOf(seed.manifest, base.file, checked.file);
    };
    const first = await once(1);
    out.catches.set(seed.id, first.catch === seed.manifest.expect ? first : await once(2));
  };
  const seeds = new Map(admitted.map((a) => [a.seed.id, catchOfSeed(a)]));
  let failed = false;
  const all = every([...seeds.values(), ...bases.values()]).then(
    () => out,
    (error: unknown) => {
      failed = true;
      throw error;
    },
  );
  return { caught: out, seeds, all, failed: () => failed };
}

/**
 * Whether the side tools keep their heavy work off a measurement alike (`### regress run`): the instances of both hold
 * the performance lease, and the heavy steps of both or of neither (`### performance lease`).
 */
export function leasedAlike(before: SideInfo, after: SideInfo): boolean {
  return before.instanceLease === true && after.instanceLease === true && (before.stepLease === true) === (after.stepLease === true);
}

/** One seed-run of the plan of a run: its seed, side, repeat and its order `k` in the run, from 1. */
export interface SeedRunPlan {
  admitted: Admitted;
  side: SideName;
  repeat: number;
  k: number;
}

/**
 * The seed-runs of `seeds` in their order (`### regress run` 3): repeat by repeat, seed by seed, the two sides of a repeat
 * next to each other, the before side first for an odd repeat and the after side first for an even one.
 */
export function seedRunPlan<T extends Admitted>(seeds: readonly T[], repeats: number): (SeedRunPlan & { admitted: T })[] {
  const plan: (SeedRunPlan & { admitted: T })[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    const sides: SideName[] = repeat % 2 === 1 ? ['before', 'after'] : ['after', 'before'];
    for (const admitted of seeds) for (const side of sides) plan.push({ admitted, side, repeat, k: plan.length + 1 });
  }
  return plan;
}

/** Removes the fix repos and their worktree folders: those of this run, and those an ended run left. */
async function removeFixRepos(ctx: Context): Promise<void> {
  const ws = await ctx.workspace();
  for (const parent of [ws.games, ws.worktrees]) {
    if (!exists(parent)) continue;
    for (const name of await readdir(parent)) if (/^ogw-regress-fix-\d+$/.test(name)) await rm(join(parent, name), { recursive: true, force: true });
  }
}

/** Removes the fix repo of seed-run `k` and its worktree folder. */
async function removeFixRepo(ctx: Context, k: number): Promise<void> {
  const ws = await ctx.workspace();
  for (const parent of [ws.games, ws.worktrees]) await rm(join(parent, fixGame(k)), { recursive: true, force: true });
}

/**
 * The folders of the fix repos of `plan` and of their worktrees, made before any fixer starts (`### regress run` 3), so
 * that the sandbox of each fixer, which takes its list of games when it starts, blocks the fix repos of the others.
 */
async function reserveFixRepos(ctx: Context, plan: readonly SeedRunPlan[]): Promise<void> {
  const ws = await ctx.workspace();
  await removeFixRepos(ctx);
  for (const { k } of plan) for (const parent of [ws.games, ws.worktrees]) await mkdir(join(parent, fixGame(k)), { recursive: true });
}

/** A fix repo: its game name, its checkout, and the root commit of its `main`, which holds the seeded tree. */
type FixRepo = SeedRunInput['fix'];

/** Makes the fix repo of seed-run `k` in its folder from the seeded commit of its seed. */
async function makeFixRepo(ctx: Context, { admitted, k }: SeedRunPlan): Promise<FixRepo> {
  const ws = await ctx.workspace();
  const game = fixGame(k);
  const state = join(ws.games, stateGame(admitted.seed.manifest.state));
  const registry = await registryCommit(ctx, state);
  const seeded = await makeCopyRepo(ctx, game, { repo: state, commit: admitted.admission.seeded as string, registry }, { kind: 'fix', state: admitted.seed.manifest.state }, 'fix repo', true);
  return { game, root: join(ws.games, game), seeded };
}

/**
 * The fix repo of each seed-run of `plan` once it starts (`### regress run` 4). Where the host clones folders
 * (`canCloneFolders`), the first seed-run of a seed to start makes its fix repo from the seeded commit and the fix repo of
 * each other seed-run of the seed as a clone of it, before any of their fixers can change one; elsewhere each seed-run
 * makes its fix repo when it starts.
 */
function fixRepos(ctx: Context, plan: readonly SeedRunPlan[]): (step: SeedRunPlan) => Promise<FixRepo> {
  const bySeed = new Map<string, Promise<Map<number, FixRepo>>>();
  const ofSeed = async (first: SeedRunPlan): Promise<Map<number, FixRepo>> => {
    const made = await makeFixRepo(ctx, first);
    const repos = new Map([[first.k, made]]);
    for (const other of plan.filter((p) => p.admitted.seed.id === first.admitted.seed.id && p.k !== first.k)) {
      const game = fixGame(other.k);
      repos.set(other.k, { game, root: await cloneCopyRepo(ctx, made.root, game), seeded: made.seeded });
    }
    return repos;
  };
  return async (step) => {
    if (!canCloneFolders()) return makeFixRepo(ctx, step);
    let repos = bySeed.get(step.admitted.seed.id);
    if (repos === undefined) {
      repos = ofSeed(step);
      bySeed.set(step.admitted.seed.id, repos);
    }
    return (await repos).get(step.k) as FixRepo;
  };
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

interface FixPhase {
  runMs: number;
  sides: Record<SideName, Side>;
  catches: Record<SideName, Catching>;
  folder: string;
  repo: string;
  pool: RegressPool;
  /**
   * The side tools keep their instances and heavy steps off a measurement alike (`### regress run`); otherwise the
   * seed-runs start once the catch of both sides has ended, and those of the seeds with `performance` run alone.
   */
  leased: boolean;
}

/** The after side's checks of the catch of a seed that has seed-runs, whose catch is not `unknown`; null otherwise. */
function catchForFix(after: SideCatch, seed: Admitted['seed']): SeedRunInput['catchAfter'] | null {
  const caught = after.catches.get(seed.id);
  const base = after.base.get(seed.manifest.state);
  const seeded = after.seeded.get(seed.id);
  if (caught === undefined || caught.catch === 'unknown' || base === undefined || !('file' in base) || seeded === undefined || !('file' in seeded)) return null;
  return { base: base.file, seeded: seeded.file, seededPath: seeded.path, matched: caught.matched };
}

/**
 * The fix phase (`### regress run` 3 and 4): every seed-run in a fix repo of its own, at most `regress.parallel` at a
 * time. With `leased`, the seed-runs of a seed start once the after side's catch of that seed has ended, in the order
 * their seeds became ready and, within a seed, in their order; without it, once the catch of both sides has ended, those
 * of the seeds with `performance` after the others, one at a time. A seed whose catch by the after side is `unknown` has
 * no seed-run. After a failure no seed-run starts, and once the started ones have ended the failure of the first in
 * their order is thrown.
 */
async function fixPhase(ctx: Context, phase: FixPhase, fixable: readonly Admitted[], repeats: number): Promise<SeedRunResult[]> {
  const settings = await ctx.settings();
  const plan = seedRunPlan(fixable, repeats);
  await reserveFixRepos(ctx, plan);
  const fixRepoOf = fixRepos(ctx, plan);
  const after = phase.catches.after.caught;
  const runOne = async (step: SeedRunPlan): Promise<SeedRunResult> => {
    const { seed } = step.admitted;
    const id = seedRunId(seed.id, step.side, step.repeat);
    try {
      return await runSeedRun(ctx, {
        runMs: phase.runMs,
        k: step.k,
        seed,
        side: phase.sides[step.side],
        after: phase.sides.after,
        repeat: step.repeat,
        fix: await fixRepoOf(step),
        catchAfter: catchForFix(after, seed) as SeedRunInput['catchAfter'],
        oracle: seed.manifest.oracle ? join(seedDir(phase.repo, seed.id), 'oracle') : null,
        work: join(phase.folder, 'fix', id),
        cap: settings.loopStop.repeatedDefect,
        diff: join(phase.repo, 'records', 'runs', String(phase.runMs), `${id}.diff`),
        pool: phase.pool,
      });
    } finally {
      // the fix repo of a seed-run goes when it ends: the next seed-run has one of its own
      await removeFixRepo(ctx, step.k);
    }
  };
  const stepsOf = (admitted: Admitted): SeedRunPlan[] => plan.filter((p) => p.admitted === admitted);
  // the seed-runs of a seed whose catch by the after side has ended; the folders of a seed without seed-runs go
  const readySteps = async (admitted: Admitted): Promise<SeedRunPlan[]> => {
    if (catchForFix(after, admitted.seed) !== null) return stepsOf(admitted);
    for (const { k } of stepsOf(admitted)) await removeFixRepo(ctx, k);
    return [];
  };
  if (!phase.leased) {
    await every([phase.catches.before.all, phase.catches.after.all]);
    const ready = (await pooled(fixable, 1, readySteps)).flat();
    const quiet = await pooled(ready.filter((p) => !p.admitted.seed.manifest.performance), settings.regress.parallel, runOne);
    const loud = await pooled(ready.filter((p) => p.admitted.seed.manifest.performance), 1, runOne);
    return [...quiet, ...loud];
  }
  const slots = limiter(settings.regress.parallel);
  const ended: { k: number; outcome: { result: SeedRunResult } | { error: unknown } }[] = [];
  let failed = false;
  // a catch that failed fails the run (`regressRun`): no seed-run starts after it
  const stopped = (): boolean => failed || phase.catches.before.failed() || phase.catches.after.failed();
  const seedRunsOf = async (admitted: Admitted): Promise<void> => {
    try {
      await phase.catches.after.seeds.get(admitted.seed.id);
    } catch (error) {
      failed = true;
      throw error;
    }
    if (stopped()) return;
    const steps = await readySteps(admitted);
    // the seed-runs of the seed take their places in the start order together, in their order
    await every(
      steps.map((step) =>
        slots.run(async () => {
          if (stopped()) return;
          try {
            ended.push({ k: step.k, outcome: { result: await runOne(step) } });
          } catch (error) {
            failed = true;
            ended.push({ k: step.k, outcome: { error } });
          }
        }),
      ),
    );
  };
  await every(fixable.map(seedRunsOf));
  ended.sort((a, b) => a.k - b.k);
  const first = ended.find((e) => 'error' in e.outcome);
  if (first !== undefined && 'error' in first.outcome) throw first.outcome.error;
  return ended.map((e) => (e.outcome as { result: SeedRunResult }).result);
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
  const [before, after] = await every([makeSide(ctx, options.before), makeSide(ctx, options.after)]);
  const sides: Record<SideName, Side> = { before, after };
  const data: RunData = { run: runMs, catchOnly: options.catchOnly, sides: [sides.before, sides.after], seeds: [], catches: [], seedRuns: [] };
  try {
    if (sides.before.unknown === null && sides.after.unknown === null) {
      const version = requireSameCore(sides.before.info as NonNullable<Side['info']>, sides.after.info as NonNullable<Side['info']>);
      const { lines, admitted } = await seedsAt(repo, version, options.seeds);
      data.seeds = lines;
      // side tools that do not keep their heavy work off a measurement alike measure only with no other check beside it
      const leased = leasedAlike(sides.before.info as SideInfo, sides.after.info as SideInfo);
      const pool = regressPool(settings.regress.parallel, !leased);
      const catches: Record<SideName, Catching> = {
        before: catchPhase(ctx, sides.before, admitted, join(folder, 'catch', 'before'), pool),
        after: catchPhase(ctx, sides.after, admitted, join(folder, 'catch', 'after'), pool),
      };
      // the seed-runs of a seed do not wait for the catch of the other seeds (`fixPhase`)
      const fixable = options.catchOnly ? [] : admitted.filter((a) => a.seed.manifest.fixer !== 'none');
      const fixing = options.catchOnly ? Promise.resolve([]) : fixPhase(ctx, { runMs, sides, catches, folder, repo, pool, leased }, fixable, options.repeats).finally(() => removeFixRepos(ctx));
      const [caughtBefore, caughtAfter, seedRuns] = await every([catches.before.all, catches.after.all, fixing]);
      data.catches = admitted.map((a): CatchLine => ({ seed: a.seed.id, before: caughtBefore.catches.get(a.seed.id) ?? null, after: caughtAfter.catches.get(a.seed.id) ?? null }));
      data.seedRuns = seedRuns;
    }
  } finally {
    await every([removeSide(ctx, sides.before), removeSide(ctx, sides.after)]);
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
