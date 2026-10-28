import { readFile, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { runLogPath } from '../../../lib/agentctx.ts';
import type { Context } from '../../../lib/command.ts';
import { exists, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { commitPaths, git, head, revParse } from '../../../lib/git.ts';
import { killJob } from '../../../lib/jobs.ts';
import type { RunState } from '../../../lib/runstate.ts';
import type { HarnessSettings } from '../../../lib/settings.ts';
import { agentOutcome, mergeAgentJobs, startAgentJob, type AgentOutcome } from '../../agent/api.ts';
import { removeAgentWorktrees } from './agent-worktrees.ts';
import { alternateSide, drawSide, evaluateDeps, judgeAgent, judgeGroup, runJudgingKeepingEnded, type EvaluateSite, type Group, type JudgePair, type JudgingPlan } from './evaluate.ts';
import { elementsOf, FUN_ITERATION_ELEMENTS, type ElementVotes, type JudgeEntry, type VsBaseline } from './files.ts';
import { abs, runRel } from './run.ts';
import { combinedVsBaseline, countVotes } from './votes.ts';

/** Dependencies tests replace: the poll interval of the wait for the variant agents. */
export const variantDeps = { pollMs: 5000 };

/** One variant of `records/loops/<run>/variants-<iteration>.json` (`game-loop` `## loop iteration record`). */
export interface VariantEntry {
  k: number;
  job: string;
  element: string;
  /** The variant commit; null without one. */
  commit: string | null;
  /** Game-repo-relative paths of the judge results of the variant. */
  judges: string[];
  /** null for a variant that was not judged: without a commit, without a baseline game, or whose judges could not all run. */
  votes: ElementVotes[] | null;
  vsBaseline: VsBaseline | null;
  /** Why the merge of the variant failed; null when it was not tried or did not fail. */
  merge: string | null;
  chosen: boolean;
}

export interface VariantsFile {
  baseline: string | null;
  /** Why the judging of the variants failed; null when it did not fail or did not run. */
  judging: string | null;
  variants: VariantEntry[];
}

/** The target element of variant `k` in iteration `iteration`: item ((k + iteration − 2) mod 3) + 1 of the fun iteration elements. */
export function targetElement(k: number, iteration: number): string {
  return FUN_ITERATION_ELEMENTS[(k + iteration - 2) % FUN_ITERATION_ELEMENTS.length] as string;
}

/** The input of variant agent `k` of `count`: the content input with `## variant` added. */
export function variantInput(content: string, k: number, count: number, element: string): string {
  return `${content.trimEnd()}\n\n## variant\n\n- variant: ${String(k)} of ${String(count)}\n- element: ${element}\n`;
}

function decided(entry: VariantEntry, decision: 'this'): number {
  return (entry.votes ?? []).filter((v) => v.decision === decision).length;
}

function votesFor(entry: VariantEntry, side: 'this' | 'baseline'): number {
  return (entry.votes ?? []).reduce((sum, v) => sum + v[side], 0);
}

/**
 * The variants with a commit in choice order (`game-loop` `## iteration` 1): those whose `vs baseline` is `better` by
 * the most elements decided `this`, the fewest `baseline` votes and the lowest k; then the others by the largest count
 * of `this` votes minus `baseline` votes and the lowest k. When a variant was judged, the variants not judged are left out.
 */
export function choiceOrder(variants: readonly VariantEntry[]): VariantEntry[] {
  const withCommit = variants.filter((v) => v.commit !== null);
  const judged = withCommit.some((v) => v.votes !== null) ? withCommit.filter((v) => v.votes !== null) : withCommit;
  const better = judged
    .filter((v) => v.vsBaseline === 'better')
    .sort((a, b) => decided(b, 'this') - decided(a, 'this') || votesFor(a, 'baseline') - votesFor(b, 'baseline') || a.k - b.k);
  const margin = (v: VariantEntry): number => votesFor(v, 'this') - votesFor(v, 'baseline');
  const rest = judged.filter((v) => v.vsBaseline !== 'better').sort((a, b) => margin(b) - margin(a) || a.k - b.k);
  return [...better, ...rest];
}

/** A variant agent of this command: its k, job and target element. */
interface Started {
  k: number;
  job: string;
  element: string;
}

/** Waits until every variant agent ended; a signal kills them before this process ends. */
async function waitAgents(ctx: Context, jobs: readonly string[]): Promise<Map<string, AgentOutcome>> {
  const outcomes = new Map<string, AgentOutcome>();
  const off = evaluateDeps.onSignal((signal) => {
    off();
    void Promise.all(jobs.map((id) => killJob(id, ctx.env).catch(() => undefined))).finally(() => {
      evaluateDeps.resignal(signal);
    });
  });
  try {
    while (outcomes.size < jobs.length) {
      for (const id of jobs) {
        if (outcomes.has(id)) continue;
        const outcome = await agentOutcome(ctx, id);
        if (outcome.status !== 'running') outcomes.set(id, outcome);
      }
      if (outcomes.size < jobs.length) await sleep(variantDeps.pollMs);
    }
  } finally {
    off();
  }
  return outcomes;
}

/** The variant commit: the HEAD of `agent/<id>` of a `done` agent that changed a path other than its run log; else null. */
async function variantCommit(ctx: Context, game: GameRepo, run: RunState, base: string, variant: Started, outcome: AgentOutcome | undefined): Promise<string | null> {
  if (outcome?.status !== 'done') return null;
  const commit = await revParse(game.root, `agent/${variant.job}`, { env: ctx.env });
  if (commit === null) return null;
  const runLog = runLogPath(runRel(run, `content-${String(run.iteration)}-v${String(variant.k)}.md`));
  const changed = await git(game.root, ['diff', '--name-only', '--no-renames', '-z', base, commit], { env: ctx.env });
  return changed.split('\0').some((path) => path !== '' && path !== runLog) ? commit : null;
}

/** The judging site of the variant judges: `judge-<n>-v<k>-<j>.md` in the run folder, the rest in its `evidence/`. */
function variantSite(game: GameRepo, run: RunState): EvaluateSite {
  const n = String(run.iteration);
  return {
    input: (role, ms) => abs(game, runRel(run, `evidence/input-${role}-${n}-${String(ms)}.json`)),
    telemetry: (pair, j) => abs(game, runRel(run, `evidence/telemetry-${n}-${pair.name}-${String(j)}.md`)),
    measure: (instance) => abs(game, runRel(run, `evidence/measure-${n}/${instance}.json`)),
    judgePlace: (pair, j) => ({
      output: abs(game, runRel(run, `judge-${n}-${pair.name}-${String(j)}.md`)),
      evidence: abs(game, runRel(run, `evidence/judge-${n}-${pair.name}-${String(j)}`)),
    }),
    judgePlaceInRun: true,
  };
}

/**
 * Runs `loop.judgeVotes` fun judges of each variant commit against the baseline, all variants in one judging. A variant
 * whose judges did not all end before a failure of the judging gets no votes; returns that failure, or null.
 */
async function judgeVariants(
  ctx: Context,
  game: GameRepo,
  run: RunState,
  settings: HarnessSettings,
  baseline: string,
  entries: readonly VariantEntry[],
  db: 'postgresql' | undefined,
): Promise<string | null> {
  const plan: JudgingPlan = { game, kind: 'fun', moments: [], reference: null, settings, db, site: variantSite(game, run) };
  const groups: Group[] = [];
  const pairs = new Map<JudgePair, VariantEntry>();
  for (const entry of entries.filter((e) => e.commit !== null)) {
    const pair: JudgePair = { name: `v${String(entry.k)}`, commit: entry.commit as string, baseline, baselineLatencyMs: 0 };
    pairs.set(pair, entry);
    const first = drawSide();
    for (let j = 1; j <= settings.loop.judgeVotes; j++) groups.push(judgeGroup(plan, pair, 'main', j, alternateSide(first, j), judgeAgent(settings, j)));
  }
  if (groups.length === 0) return null;
  const { slots, failure } = await runJudgingKeepingEnded(ctx, plan, groups);
  const judged = new Map<VariantEntry, { j: number; entry: JudgeEntry | null }[]>();
  for (const slot of slots) {
    const entry = slot.role === 'judge' ? pairs.get(slot.pair) : undefined;
    if (slot.role !== 'judge' || entry === undefined) continue;
    judged.set(entry, [...(judged.get(entry) ?? []), { j: slot.k, entry: slot.entry }]);
  }
  for (const [entry, list] of judged) {
    const ended = list.sort((a, b) => a.j - b.j).flatMap((x) => (x.entry === null ? [] : [x.entry]));
    entry.judges = ended.map((j) => j.result).filter((r) => r !== '');
    // a variant whose judges could not all run is not judged
    if (ended.length < list.length) continue;
    entry.votes = countVotes(ended, elementsOf('fun'), settings.loop.judgeVotes);
    entry.vsBaseline = combinedVsBaseline(entry.votes, ended.some((j) => j.lostMoments.length > 0));
  }
  return failure;
}

export interface VariantsResult {
  file: VariantsFile;
  path: string;
  chosen: VariantEntry | null;
}

/** Writes and commits the inputs of the variant agents, then starts them on the work branch HEAD; returns that HEAD. */
async function startVariants(ctx: Context, game: GameRepo, run: RunState, count: number): Promise<{ base: string; started: Started[] }> {
  const n = run.iteration;
  const content = await readFile(abs(game, runRel(run, `content-input-${String(n)}.md`)), 'utf8');
  const inputs: string[] = [];
  for (let k = 1; k <= count; k++) {
    const rel = runRel(run, `content-input-${String(n)}-v${String(k)}.md`);
    await writeFileAtomic(abs(game, rel), variantInput(content, k, count, targetElement(k, n)));
    inputs.push(rel);
  }
  await commitPaths(game.root, inputs, `loop ${run.name}: variant inputs ${String(n)}`, { env: ctx.env });
  const base = await head(game.root, { env: ctx.env });
  const started: Started[] = [];
  try {
    for (let k = 1; k <= count; k++) {
      const job = await startAgentJob(ctx, { role: 'content', game: game.name, input: abs(game, inputs[k - 1] as string), variant: k });
      started.push({ k, job, element: targetElement(k, n) });
    }
  } catch (error) {
    await Promise.all(started.map((s) => killJob(s.job, ctx.env).catch(() => undefined)));
    throw error;
  }
  return { base, started };
}

/** The entry of each variant agent that ended, and the report of each variant with a variant commit by k. */
async function entriesOf(
  ctx: Context,
  game: GameRepo,
  run: RunState,
  base: string,
  started: readonly Started[],
  outcomes: ReadonlyMap<string, AgentOutcome>,
): Promise<{ entries: VariantEntry[]; reports: Map<number, string> }> {
  const entries: VariantEntry[] = [];
  const reports = new Map<number, string>();
  for (const variant of started) {
    const outcome = outcomes.get(variant.job);
    const commit = await variantCommit(ctx, game, run, base, variant, outcome);
    const output = outcome?.output ?? null;
    if (commit !== null && output !== null) reports.set(variant.k, await readFile(output, 'utf8'));
    entries.push({ k: variant.k, job: variant.job, element: variant.element, commit: reports.has(variant.k) ? commit : null, judges: [], votes: null, vsBaseline: null, merge: null, chosen: false });
  }
  return { entries, reports };
}

/**
 * Merges the variants in choice order until one merges, with `content-<n>.md` (its report), `variants-<n>.json` and the
 * judge results in the merge commit. Without a merge, commits `variants-<n>.json` and the judge results. Returns the
 * merged variant, or null.
 */
async function mergeChosen(ctx: Context, game: GameRepo, run: RunState, file: VariantsFile, reports: ReadonlyMap<number, string>): Promise<{ path: string; chosen: VariantEntry | null }> {
  const n = String(run.iteration);
  const path = runRel(run, `variants-${n}.json`);
  const report = runRel(run, `content-${n}.md`);
  const judgeFiles = file.variants.flatMap((e) => e.judges).filter((r) => exists(abs(game, r)));
  for (const entry of choiceOrder(file.variants)) {
    for (const e of file.variants) e.chosen = e === entry;
    await writeFileAtomic(abs(game, report), reports.get(entry.k) as string);
    await writeJsonAtomic(abs(game, path), file);
    const merged = await mergeAgentJobs(ctx, [entry.job], { alsoCommit: [report, path, ...judgeFiles] });
    if (merged.merged.includes(entry.job)) return { path, chosen: entry };
    const failure = merged.failed.find((f) => f.id === entry.job);
    entry.merge = failure === undefined ? 'not merged' : `${failure.reason}: ${failure.detail}`;
    entry.chosen = false;
  }
  await rm(abs(game, report), { force: true });
  await writeJsonAtomic(abs(game, path), file);
  await commitPaths(game.root, [path, ...judgeFiles], `loop ${run.name}: variants ${n}`, { env: ctx.env });
  return { path, chosen: null };
}

/**
 * `ogw loop variants` (`game-loop` `## iteration` 1): writes and commits the variant inputs, runs the variant agents,
 * judges their commits, merges the chosen one with its records, and removes the worktrees of the others.
 */
export async function runVariants(
  ctx: Context,
  game: GameRepo,
  run: RunState,
  settings: HarnessSettings,
  baseline: string | null,
  db?: 'postgresql',
): Promise<VariantsResult> {
  const { base, started } = await startVariants(ctx, game, run, settings.loop.variants);
  const outcomes = await waitAgents(ctx, started.map((s) => s.job));
  const { entries, reports } = await entriesOf(ctx, game, run, base, started, outcomes);
  const judging = baseline === null ? null : await judgeVariants(ctx, game, run, settings, baseline, entries, db);
  const file: VariantsFile = { baseline, judging, variants: entries };
  const { path, chosen } = await mergeChosen(ctx, game, run, file, reports);
  await removeAgentWorktrees(ctx, game, entries.filter((e) => e !== chosen).map((e) => e.job));
  return { file, path, chosen };
}
