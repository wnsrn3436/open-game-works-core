/** `ogw regress run` (ogw.md `### regress run` of `## regress`): the sides, the catch, the fix and the report. */
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import type { AgentSettings } from '../../../lib/settings.ts';
import { dataDir } from '../../env/lib/host.ts';
import { makeCopyRepo, registryCommit } from './copy.ts';
import { every, pooled, regressPool, type RegressPool } from './pool.ts';
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

type Checked = { file: RegressCheckFile; path: string } | { error: string };

interface SideCatch {
  base: Map<string, Checked>;
  seeded: Map<string, Checked>;
  catches: Map<string, CatchResult>;
}

/**
 * The catch of each admitted seed by one side (`### regress run` 2): the check of the base of each state and the first
 * check of each seeded commit together, the catch of a seed once the check of the base of its state has ended, and the
 * second check of a catch that is not its `expect`.
 */
async function catchPhase(ctx: Context, side: Side, admitted: readonly Admitted[], folder: string, pool: RegressPool): Promise<SideCatch> {
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
  await every([...admitted.map(catchOfSeed), ...bases.values()]);
  return out;
}

/** One seed-run of the plan of a run: its seed, side, repeat and its order `k` in the run, from 1. */
export interface SeedRunPlan {
  admitted: Admitted;
  side: SideName;
  repeat: number;
  k: number;
}

/**
 * The seed-runs of `seeds` in the order they start (`### regress run` 4): repeat by repeat, seed by seed, the two sides of
 * a repeat next to each other, the before side first for an odd repeat and the after side first for an even one.
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

/**
 * The folders of the fix repos of `plan` and of their worktrees, made before any fixer starts (`### regress run` 3), so
 * that the sandbox of each fixer, which takes its list of games when it starts, blocks the fix repos of the others.
 */
async function reserveFixRepos(ctx: Context, plan: readonly SeedRunPlan[]): Promise<void> {
  const ws = await ctx.workspace();
  await removeFixRepos(ctx);
  for (const { k } of plan) for (const parent of [ws.games, ws.worktrees]) await mkdir(join(parent, fixGame(k)), { recursive: true });
}

/** Makes the fix repo of seed-run `k` in its folder from the seeded commit of its seed: its root and the root commit of `main`. */
async function makeFixRepo(ctx: Context, { admitted, k }: SeedRunPlan): Promise<{ game: string; root: string; seeded: string }> {
  const ws = await ctx.workspace();
  const game = fixGame(k);
  const state = join(ws.games, stateGame(admitted.seed.manifest.state));
  const registry = await registryCommit(ctx, state);
  const seeded = await makeCopyRepo(ctx, game, { repo: state, commit: admitted.admission.seeded as string, registry }, { kind: 'fix', state: admitted.seed.manifest.state }, `fix repo ${String(k)}`, true);
  return { game, root: join(ws.games, game), seeded };
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
  after: SideCatch;
  folder: string;
  repo: string;
  pool: RegressPool;
  /** The side tools hold the performance lease for their instances; otherwise the seeds with `performance` run alone. */
  leased: boolean;
}

/**
 * The fix phase (`### regress run` 3 and 4): every seed-run in a fix repo of its own, at most `regress.parallel` at a
 * time; without `leased`, the seed-runs of the seeds with `performance` after the others, one at a time.
 */
async function fixPhase(ctx: Context, phase: FixPhase, fixable: readonly Admitted[], repeats: number): Promise<SeedRunResult[]> {
  const settings = await ctx.settings();
  const ready = fixable.filter(({ seed }) => {
    const base = phase.after.base.get(seed.manifest.state);
    const seeded = phase.after.seeded.get(seed.id);
    return base !== undefined && 'file' in base && seeded !== undefined && 'file' in seeded;
  });
  const plan = seedRunPlan(ready, repeats);
  await reserveFixRepos(ctx, plan);
  const runOne = async (step: SeedRunPlan): Promise<SeedRunResult> => {
    const { seed } = step.admitted;
    const base = phase.after.base.get(seed.manifest.state) as { file: RegressCheckFile };
    const seeded = phase.after.seeded.get(seed.id) as { file: RegressCheckFile; path: string };
    const id = seedRunId(seed.id, step.side, step.repeat);
    const ws = await ctx.workspace();
    try {
      return await runSeedRun(ctx, {
        runMs: phase.runMs,
        k: step.k,
        seed,
        side: phase.sides[step.side],
        after: phase.sides.after,
        repeat: step.repeat,
        fix: await makeFixRepo(ctx, step),
        catchAfter: { base: base.file, seeded: seeded.file, seededPath: seeded.path, matched: phase.after.catches.get(seed.id)?.matched ?? null },
        oracle: seed.manifest.oracle ? join(seedDir(phase.repo, seed.id), 'oracle') : null,
        work: join(phase.folder, 'fix', id),
        cap: settings.loopStop.repeatedDefect,
        diff: join(phase.repo, 'records', 'runs', String(phase.runMs), `${id}.diff`),
        pool: phase.pool,
      });
    } finally {
      // the fix repo of a seed-run goes when it ends: the next seed-run has one of its own
      for (const parent of [ws.games, ws.worktrees]) await rm(join(parent, fixGame(step.k)), { recursive: true, force: true });
    }
  };
  if (phase.leased) return pooled(plan, settings.regress.parallel, runOne);
  const quiet = await pooled(plan.filter((p) => !p.admitted.seed.manifest.performance), settings.regress.parallel, runOne);
  const loud = await pooled(plan.filter((p) => p.admitted.seed.manifest.performance), 1, runOne);
  return [...quiet, ...loud];
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
      // a side tool whose instances do not hold the performance lease measures only with no other check beside it
      const leased = sides.before.info?.instanceLease === true && sides.after.info?.instanceLease === true;
      const pool = regressPool(settings.regress.parallel, !leased);
      const [caughtBefore, caughtAfter] = await every([
        catchPhase(ctx, sides.before, admitted, join(folder, 'catch', 'before'), pool),
        catchPhase(ctx, sides.after, admitted, join(folder, 'catch', 'after'), pool),
      ]);
      data.catches = admitted.map((a): CatchLine => ({ seed: a.seed.id, before: caughtBefore.catches.get(a.seed.id) ?? null, after: caughtAfter.catches.get(a.seed.id) ?? null }));
      if (!options.catchOnly) {
        const fixable = admitted.filter((a) => a.seed.manifest.fixer !== 'none' && caughtAfter.catches.get(a.seed.id)?.catch !== 'unknown');
        try {
          data.seedRuns = await fixPhase(ctx, { runMs, sides, after: caughtAfter, folder, repo, pool, leased }, fixable, options.repeats);
        } finally {
          await removeFixRepos(ctx);
        }
      }
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
