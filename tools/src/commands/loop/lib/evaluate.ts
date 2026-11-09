import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, formatJson, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { commitPaths, showFile } from '../../../lib/git.ts';
import { newId } from '../../../lib/ids.ts';
import { killJob, readJob } from '../../../lib/jobs.ts';
import type { RunState } from '../../../lib/runstate.ts';
import { openSpan, openWait, span, type OpenSpan } from '../../../lib/spans.ts';
import type { AgentSettings, HarnessSettings } from '../../../lib/settings.ts';
import { agentOutcome, startAgentJob, type AgentOutcome, type CalibrationPlace } from '../../agent/api.ts';
import { clearPlayBudget } from '../../agent/lib/play-budget.ts';
import { listInstances, startInstance, stopInstance, type InstanceInfo, type InstanceOptions, type StartFailure } from '../../instance/api.ts';
import { clearReleases, takeReleases } from '../../instance/lib/releases.ts';
import { instancesDir } from '../../instance/lib/records.ts';
import { clearUnstarted, noteUnstarted } from '../../instance/lib/unstarted.ts';
import { collectMeasure, measureCollected } from '../../measure/api.ts';
import { telemetrySummary } from '../../telemetry/api.ts';
import {
  checkResult,
  elementsOf,
  successPrecondition,
  type CheckFile,
  type EvaluateFile,
  type IterationKind,
  type JudgeAgent,
  type JudgeEntry,
  type JudgeKind,
  type PlayEntry,
  type VsBaseline,
  type VsReference,
} from './files.ts';
import { appendCoverage, judgeReadingOf, judgeResultErrors, judgeVerdict, type JudgeVerdict } from './results.ts';
import { abs, runRel } from './run.ts';
import { combinedVsBaseline, combinedVsReference, countVotes } from './votes.ts';
import { MEMORABLE_MOMENT, NAME_FILE, parseGameNames, type Moment, type Reference } from './setup.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;
/** Grace time of each agent job kill when a signal stops `ogw loop evaluate`: the job supervisor kills it 5000 ms after SIGTERM. */
const SIGNAL_KILL_GRACE_MS = 2000;

/** Dependencies tests replace: the A/B coin, the poll intervals, the clock, and the signal handling. */
export const evaluateDeps = {
  /** Returns a number in [0, 1); below 0.5 puts this commit's instance in `A`. */
  random: Math.random,
  /**
   * The longest wait between two polls of the running agents: a poll reads one job record and one release folder per
   * agent, and an instance start, stop or other work of the run that ends wakes the wait at once.
   */
  pollMs: 1000,
  now: Date.now,
  /** Calls `handler` on SIGTERM and SIGINT until the returned function is called. */
  onSignal: (handler: (signal: NodeJS.Signals) => void): (() => void) => {
    for (const signal of SIGNALS) process.on(signal, handler);
    return () => {
      for (const signal of SIGNALS) process.off(signal, handler);
    };
  },
  /**
   * After a signal, how long the handler waits for the run to settle (an instance or agent job start in flight ends,
   * and the run cleans up what it started) before it sends the signal again; within the 5000 ms before SIGKILL.
   */
  signalSettleMs: 3000,
  /** Sends the signal again once this process no longer handles it, so it ends the process (`proc.ts` or the default action). */
  resignal: (signal: NodeJS.Signals): void => {
    process.kill(process.pid, signal);
  },
};

export interface EvaluatePlan {
  game: GameRepo;
  run: RunState;
  check: CheckFile;
  commit: string;
  baseline: string | null;
  moments: Moment[];
  reference: Reference;
  /** The iteration kind: a fun iteration has no play of a moment, no `vs reference` and no success judge. */
  kind: IterationKind;
  platforms: string[];
  settings: Pick<
    HarnessSettings,
    'maxConcurrentInstances' | 'instanceWaitTimeoutMs' | 'playInstances' | 'backgroundRetryLimit' | 'loopStop' | 'loop' | 'agents'
  >;
  /** True when `ogw loop input` asked for the judge moment `memorable_moment` in this run. */
  memorableMoment: boolean;
  /** Folder of the save fixtures taken from the work branch HEAD (`fixturesAtHead`). */
  fixtureDir?: string;
}

/** The two commits a step 4 judge compares, and how their instances start. */
export interface JudgePair {
  /** The pair name of `ogw judge calibrate`; empty in `ogw loop evaluate`. */
  name: string;
  /** This commit. */
  commit: string;
  baseline: string | null;
  /** `--input-latency` of the instances of the baseline commit (the degraded pair of `ogw judge calibrate`); 0 for none. */
  baselineLatencyMs: number;
}

/** Where the judging puts its files: the run of `ogw loop evaluate`, or the calibration folders of `ogw judge calibrate`. */
export interface EvaluateSite {
  /** Absolute path of the agent input file of `role` written at unix ms `ms`. */
  input(role: 'play' | 'judge', ms: number): string;
  /** Absolute path of the `ogw measure` raw data of a play instance. */
  measure(instance: string): string;
  /**
   * The result file and evidence folder of a judge agent; null for the place `ogw agent` gives a judge of the open run.
   * A judge with a place starts without a run unless `judgePlaceInRun` is true.
   */
  judgePlace(pair: JudgePair, k: number): CalibrationPlace | null;
  /** True when a judge with a place of `judgePlace` starts in the open run (`ogw loop variants`). */
  judgePlaceInRun?: boolean;
}

/** What the judging and play machinery runs with. `ogw loop evaluate` and `ogw judge calibrate` make it. */
export interface JudgingPlan {
  game: GameRepo;
  kind: IterationKind;
  moments: Moment[];
  /** null: no comparison with the reference game. */
  reference: Reference | null;
  settings: EvaluatePlan['settings'];
  fixtureDir?: string;
  site: EvaluateSite;
  /** Whether the success judges start, once every step 4 judge ended; absent: no success judge opens. */
  successOpen?: (main: readonly JudgeEntry[]) => boolean;
  /** Groups that come while the judging runs (`ogw loop variants`); absent: every group is in the queue it starts with. */
  feed?: JudgingFeed;
}

/** Groups that come while the judging runs, each judged as it comes. */
export interface JudgingFeed {
  /** The groups that came since the last call, and true once no more come. A failure ends the judging with it. */
  next(): Promise<{ groups: Group[]; done: boolean }>;
  /** The agent jobs a signal kills with the judging: those whose end brings groups. */
  jobs(): readonly string[];
}

/** What holds instance slots of the run: a play slot or a judge slot. */
interface Holder {
  /** Its instances that are starting, running or stopping. */
  live: number;
  /** Its instances that are starting. */
  starting: number;
  /** The slots it keeps while it stops its instances to start new ones (a call again). */
  reserved: number;
  /** The step span of a play or judge, from its first instance start to its entry (ogw.md `## time`). */
  span?: OpenSpan;
}

/** An instance to start. A start that fails for another reason than a save fixture step ends `ogw loop evaluate`. */
interface Spec {
  commit: string;
  platform?: string;
  fixture?: string;
  /** `--input-latency` of the instance; absent or 0 for none. */
  inputLatencyMs?: number;
  /** The id the instance gets: one a judge input named before the start. */
  id?: string;
}

interface PlaySlot extends Holder {
  role: 'play';
  spec: Spec;
  platform: string;
  moment: Moment | null;
  /** Collects `ogw measure` raw data before stopping (the `playInstances` instances). */
  measure: boolean;
  /** The raw data file collected from its instance; null without one. */
  measureFile: string | null;
  attempts: number;
  instance: InstanceInfo | null;
  job: string | null;
  entry: PlayEntry | null;
}

/** An instance of a judge input that starts as the judge gives other instances back, with the id the input names. */
interface PendingInstance {
  id: string;
  spec: Spec;
}

export interface JudgeSlot extends Holder {
  role: 'judge';
  kind: JudgeKind;
  pair: JudgePair;
  /** The order of a step 4 judge from 1; 0 for a success judge. */
  k: number;
  agent: AgentSettings;
  side: 'A' | 'B';
  moments: Moment[];
  omitted: string[];
  /** Most instances the judge holds at once: those it starts with, and as it gives back instances, the next of `pending`. */
  budget: number;
  /** Instances of the judge input not started yet, in the order the judge plays them, with the ids the input names. */
  pending: PendingInstance[];
  /** Ids of the pending instances whose start runs. */
  inFlight: Set<string>;
  /** Ids the judge gave back with `ogw instance release`; one whose start ran then is stopped once it started. */
  released: Set<string>;
  attempts: number;
  instances: InstanceInfo[];
  /** The judge input file of its current call, which sets what of its judge result is read; null before its first call. */
  input: string | null;
  job: string | null;
  entry: JudgeEntry | null;
}

export type Slot = PlaySlot | JudgeSlot;

export interface Group {
  size: number;
  slots: Slot[];
  /** Success judges wait for the step 4 judges and start only when the rest of `success` holds. */
  gate: 'none' | 'success';
}

interface State {
  ctx: Context;
  plan: JudgingPlan;
  queue: Group[];
  /** Every slot in plan order. */
  all: Slot[];
  /** Slots whose agent runs, which each poll reads. */
  active: Slot[];
  /** Every instance started and not stopped yet. */
  instances: Map<string, InstanceInfo>;
  /** What holds each instance of `instances`. */
  owners: Map<string, Holder>;
  /** Ids of the instances whose `startInstance` reserved a slot and has not returned yet. */
  starting: Set<string>;
  jobs: Set<string>;
  successGate: 'pending' | 'open' | 'closed';
  lastInputMs: number;
  /** When the first queued group began waiting for room while this run held no instance; null when not waiting. */
  waitingSince: number | null;
  /** The wait for room among the instances of other runs while `waitingSince` is set (ogw.md `## time`). */
  roomWait?: { end: () => void };
  /** The name of that wait: the instance slots of the host (ogw.md `## time`). */
  slotsName: string;
  /** The signal that stopped this run; null while it runs. */
  stoppedBy: NodeJS.Signals | null;
  /** The first failure of the work in `tasks`, which ends the run; null while none failed. */
  failure: { error: unknown } | null;
  /** Aborted on the signal and on a failure: ends the wait between polls and stops the instance starts in flight. */
  wake: AbortController;
  /** Aborted when work of `tasks` or an instance start or stop ends: ends the wait between polls. */
  nudge: AbortController;
  /** The work that runs beside the polls: instance starts, stops, finishing an ended agent. */
  tasks: Set<Promise<void>>;
  /** True once the feed gives no more groups. */
  feedDone: boolean;
  /** Resolves when `runSlots` ended and the run cleaned up after a failure. */
  settled: Promise<void>;
  /** The folder of the `play-guide.md` files of the commits the judges compare, made at the first judge; null before. */
  guides: Promise<string> | null;
  /** The `<game>` of a judge input per commit, without the instance (`sideOf`). */
  sides: Map<string, Promise<{ playGuide: string; names: Record<string, string> | null }>>;
}

function fixturePath(plan: Pick<JudgingPlan, 'fixtureDir'>, moment: Moment): string {
  if (plan.fixtureDir === undefined) throw new OgwError('the save fixtures of the work branch HEAD were not taken');
  return join(plan.fixtureDir, `${moment.name}.json`);
}

/**
 * Writes `client/dev/bot/fixtures/<moment>.json` of the work branch HEAD into a new temp folder for every
 * moment: every save fixture instance, whatever its commit, gets that file (ogw.md `## loop evaluate`).
 * A moment without the file at HEAD gets no file, so its instance start fails on the save fixture.
 */
export async function fixturesAtHead(ctx: Context, plan: EvaluatePlan): Promise<string> {
  const dir = await newPrivateTempFolder('ogw-fixtures-', ctx.env);
  for (const moment of plan.moments) {
    const bytes = await showFile(plan.game.root, 'HEAD', `client/dev/bot/fixtures/${moment.name}.json`, { env: ctx.env });
    if (bytes !== null) await writeFile(join(dir, `${moment.name}.json`), bytes);
  }
  return dir;
}

/** The moments whose save fixture instances a judge gets, and those left out by `maxConcurrentInstances`. */
function judgeMoments(plan: Pick<JudgingPlan, 'moments' | 'settings'>, pair: JudgePair): { included: Moment[]; omitted: string[]; size: number } {
  const perGame = pair.baseline === null ? 1 : 2;
  const max = plan.settings.maxConcurrentInstances;
  const included: Moment[] = [];
  const omitted: string[] = [];
  for (const moment of plan.moments) {
    if (max === null || (included.length + 2) * perGame <= max) included.push(moment);
    else omitted.push(moment.name);
  }
  return { included, omitted, size: (included.length + 1) * perGame };
}

/**
 * Instances of one judge: a pair per judge moment, then this commit and the baseline from the first screen, within
 * `maxConcurrentInstances`. The group holds the judge's budget (`judgeBudget`) of `slots`, the slots of its kind
 * (`maxConcurrentInstances` when omitted): the judge starts with that many of its instances and gets the others as it
 * gives instances back, so `together` judges that start together run at once.
 */
export function judgeGroup(
  plan: Pick<JudgingPlan, 'moments' | 'settings'>,
  pair: JudgePair,
  kind: JudgeKind,
  k: number,
  side: 'A' | 'B',
  agent: AgentSettings,
  together: number,
  slots: number | null = plan.settings.maxConcurrentInstances,
): Group {
  const { included, omitted, size } = judgeMoments(plan, pair);
  const budget = judgeBudget(slots, pair.baseline === null ? 1 : 2, included.length, together);
  const slot: JudgeSlot = {
    role: 'judge',
    kind,
    pair,
    k,
    agent,
    side,
    moments: included,
    omitted,
    budget: Math.min(size, budget),
    pending: [],
    inFlight: new Set(),
    released: new Set(),
    attempts: 0,
    instances: [],
    input: null,
    job: null,
    entry: null,
    live: 0,
    starting: 0,
    reserved: 0,
  };
  return { size: slot.budget, slots: [slot], gate: kind === 'success' ? 'success' : 'none' };
}

/**
 * Most instances a judge holds at once: its share of `slots`, the slots of its kind, among the `together` judges that
 * start together, and at least one instance per side, as the judge plays its instances one moment at a time in the
 * order they start (`judgeSpecs`). All of them without `maxConcurrentInstances` (`slots` null).
 */
export function judgeBudget(slots: number | null, perGame: number, moments: number, together: number): number {
  const all = (moments + 1) * perGame;
  if (slots === null) return all;
  return Math.min(all, Math.max(perGame, Math.floor(slots / Math.max(1, together))));
}

/**
 * The agent CLI, model and effort of the k-th step 4 judge: `loop.judgePanel` in turn, each item for two judges in a row
 * so that, with the sides alternating per judge, each item judges both side assignments; else `agents.judge`.
 */
export function judgeAgent(settings: Pick<EvaluatePlan['settings'], 'loop' | 'agents'>, k: number): AgentSettings {
  const panel = settings.loop.judgePanel;
  if (panel.length > 0) return panel[Math.floor((k - 1) / 2) % panel.length] as AgentSettings;
  const judge = settings.agents.judge;
  if (judge === undefined) throw new OgwError('harness settings agents.judge is missing');
  return judge;
}

/** The side of this commit's instance by the coin: below 0.5 is `A`. */
export function drawSide(): 'A' | 'B' {
  return evaluateDeps.random() < 0.5 ? 'A' : 'B';
}

/** The side of this commit for the k-th judge (k from 1) when the first judge has `first`: the sides alternate. */
export function alternateSide(first: 'A' | 'B', k: number): 'A' | 'B' {
  if (k % 2 === 1) return first;
  return first === 'A' ? 'B' : 'A';
}

function playSlot(spec: Spec, platform: string, moment: Moment | null, measure: boolean): PlaySlot {
  return { role: 'play', spec, platform, moment, measure, measureFile: null, attempts: 0, instance: null, job: null, entry: null, live: 0, starting: 0, reserved: 0 };
}

/**
 * Groups in start order (ogw.md `## loop evaluate`): each step 4 judge (`loop.judgeVotes` with a baseline game,
 * else one; the first on a random side, each next on the other side), the `playInstances` plays, a play per judge
 * moment, and in a completeness iteration of a loop run the success judges (a random side each, with the agent of the
 * first step 4 judge).
 */
export function planGroups(plan: EvaluatePlan): Group[] {
  const pair: JudgePair = { name: '', commit: plan.commit, baseline: plan.baseline, baselineLatencyMs: 0 };
  const count = plan.baseline === null ? 1 : plan.settings.loop.judgeVotes;
  const first = plan.baseline === null ? 'A' : drawSide();
  const plays = playGroups(plan);
  // the judges of each kind share the slots that step 3 leaves, so that the plays run beside them
  const max = plan.settings.maxConcurrentInstances;
  const slots = max === null ? null : max - plays.reduce((n, g) => n + g.size, 0);
  const groups: Group[] = [];
  for (let k = 1; k <= count; k++) {
    groups.push(judgeGroup(plan, pair, 'main', k, alternateSide(first, k), judgeAgent(plan.settings, k), count, slots));
  }
  return [...groups, ...plays, ...successGroups(plan, pair, slots)];
}

/** The `playInstances` plays and a play per judge moment; none in a fun iteration. */
function playGroups(plan: EvaluatePlan): Group[] {
  // no play agent plays in a fun iteration: its findings would wait for a completeness iteration, and the bot playtest gates blockers
  if (plan.kind === 'fun') return [];
  const groups: Group[] = [];
  const plays: Slot[] = [];
  for (let k = 0; k < plan.settings.playInstances; k++) {
    const platform = plan.platforms[k % plan.platforms.length] as string;
    plays.push(playSlot({ commit: plan.commit, platform }, platform, null, true));
  }
  if (plays.length > 0) groups.push({ size: plays.length, slots: plays, gate: 'none' });
  const firstPlatform = plan.platforms[0] as string;
  for (const moment of plan.moments) {
    groups.push({ size: 1, slots: [playSlot({ commit: plan.commit, fixture: fixturePath(plan, moment) }, firstPlatform, moment, false)], gate: 'none' });
  }
  return groups;
}

/** The success judges of a completeness iteration, in `slots`: a random side each. */
function successGroups(plan: EvaluatePlan, pair: JudgePair, slots: number | null): Group[] {
  if (plan.kind !== 'completeness') return [];
  const agent = judgeAgent(plan.settings, 1);
  const successJudges = plan.settings.loopStop.successJudges;
  return Array.from({ length: successJudges }, () =>
    judgeGroup(plan, pair, 'success', 0, plan.baseline === null ? 'A' : drawSide(), agent, successJudges, slots),
  );
}

/**
 * Writes an agent input file, through a temporary file and a rename. The write does not wait: the agents whose instances
 * started first start first, whatever the order the file system ends writes in.
 */
function inputFile(state: State, role: 'play' | 'judge', input: unknown): string {
  let ms = evaluateDeps.now();
  if (ms <= state.lastInputMs) ms = state.lastInputMs + 1;
  state.lastInputMs = ms;
  const path = state.plan.site.input(role, ms);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${String(process.pid)}-${newId()}`;
  try {
    writeFileSync(tmp, formatJson(input));
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return path;
}

/** `reason` of the `StartFailure` data of a `startInstance` error, or null. */
function startFailureReason(error: unknown): StartFailure['reason'] | null {
  return error instanceof OgwError ? ((error.data as Partial<StartFailure> | undefined)?.reason ?? null) : null;
}

/** The degradation of an instance: its `--input-latency`. */
type Degrade = Pick<Spec, 'inputLatencyMs'>;

/** The `startInstance` options of the degradation of an instance. */
function degradeOptions(degrade: Degrade): Pick<InstanceOptions, 'inputLatencyMs'> {
  return degrade.inputLatencyMs !== undefined && degrade.inputLatencyMs > 0 ? { inputLatencyMs: degrade.inputLatencyMs } : {};
}

/** The values of every promise once all settled; the first rejection once all settled, so that no work of it still runs. */
async function allSettled<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}

/** Ends the wait between polls at once. */
function nudge(state: State): void {
  state.nudge.abort();
}

/**
 * Runs `work` beside the polls. Its first failure ends the run: the wait between polls ends, and the instance starts in
 * flight stop at their next step. Its end wakes the wait.
 */
function spawn(state: State, work: () => Promise<void>): void {
  const task: Promise<void> = work()
    .catch((error: unknown) => {
      state.failure ??= { error };
      state.wake.abort();
    })
    .finally(() => {
      state.tasks.delete(task);
      nudge(state);
    });
  state.tasks.add(task);
}

/** Waits until no work of `tasks` runs, the work that work started included. */
async function settleTasks(state: State): Promise<void> {
  while (state.tasks.size > 0) await Promise.all([...state.tasks]);
}

/**
 * Starts an instance for `owner`; null when a save fixture step failed (ogw.md `## loop evaluate` "An instance that could
 * not be started with its save fixture is not put in"). It counts in `owner` from the call on, before its first wait.
 */
async function start(state: State, spec: Spec, owner: Holder): Promise<InstanceInfo | null> {
  checkStopped(state);
  const options: InstanceOptions = { game: state.plan.game.name, commit: spec.commit, client: 'window', ...degradeOptions(spec) };
  if (spec.platform !== undefined) options.platform = spec.platform;
  if (spec.fixture !== undefined) options.fixture = spec.fixture;
  else options.played = true;
  if (spec.id !== undefined) options.id = spec.id;
  const reserved: string[] = [];
  let info: InstanceInfo | null = null;
  owner.live++;
  owner.starting++;
  try {
    // A signal ends a wait for a slot without one, and stops an instance start that reserved one at its next step.
    info = await startInstance(state.ctx, options, {
      signal: state.wake.signal,
      onReserved: (id) => {
        reserved.push(id);
        state.starting.add(id);
      },
    });
    state.instances.set(info.id, info);
    state.owners.set(info.id, owner);
    return info;
  } catch (error) {
    checkStopped(state);
    if (startFailureReason(error) === 'fixture') return null;
    throw new OgwError(`instance start failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    owner.starting--;
    if (info === null) owner.live--;
    for (const id of reserved) state.starting.delete(id);
    nudge(state);
  }
}

/** Starts the agent job of a slot once its instances started; a signal during the instance starts stops the run first. */
async function startJob(state: State, slot: Slot, input: string): Promise<void> {
  checkStopped(state);
  const place = slot.role === 'judge' ? state.plan.site.judgePlace(slot.pair, slot.k) : null;
  const placed = place === null ? {} : state.plan.site.judgePlaceInRun === true ? { runPlace: place } : { calibration: place };
  const agent = slot.role === 'judge' ? { agent: slot.agent, ...placed } : {};
  slot.job = await startAgentJob(state.ctx, { role: slot.role, game: state.plan.game.name, input, ...agent });
  state.jobs.add(slot.job);
  state.active.push(slot);
}

/** Stops an instance of the run; it counts in its owner until the stop ended. */
async function stop(state: State, instance: InstanceInfo | null): Promise<void> {
  if (!instance || !state.instances.has(instance.id)) return;
  const owner = state.owners.get(instance.id);
  state.instances.delete(instance.id);
  state.owners.delete(instance.id);
  try {
    await stopInstance(state.ctx, instance.id);
  } finally {
    if (owner !== undefined) owner.live--;
    nudge(state);
  }
}

/**
 * The `<game>` of a judge input without its instance: `play-guide.md` of the commit, written from git into the guides
 * folder of the run (a path where no file is when the commit has none), and the game's name per language of
 * `records/setup/name.md` of the commit, which its logo reads. Read from git, as the first-screen instance of the side
 * can start after the judge (ogw.md `## loop evaluate`).
 */
async function sideOf(state: State, commit: string): Promise<{ playGuide: string; names: Record<string, string> | null }> {
  let side = state.sides.get(commit);
  if (side === undefined) {
    side = (async () => {
      const env = { env: state.ctx.env };
      state.guides ??= newPrivateTempFolder('ogw-guides-', state.ctx.env);
      const guides = await state.guides;
      const playGuide = join(guides, commit, 'play-guide.md');
      const text = await showFile(state.plan.game.root, commit, 'play-guide.md', env);
      if (text !== null) {
        await mkdir(join(guides, commit), { recursive: true });
        await writeFile(playGuide, text);
      }
      const names = await showFile(state.plan.game.root, commit, NAME_FILE, env);
      return { playGuide, names: names === null ? null : Object.fromEntries(parseGameNames(names.toString('utf8'))) };
    })();
    state.sides.set(commit, side);
  }
  return side;
}

async function launchPlay(state: State, slot: PlaySlot): Promise<void> {
  slot.instance = await start(state, slot.spec, slot);
  if (!slot.instance) {
    slot.entry = { result: '', instance: '', platform: slot.platform, moment: slot.moment?.name ?? null, status: 'failed' };
    return;
  }
  const input = inputFile(state, 'play', { instance: slot.instance.id, playGuide: join(slot.instance.root, 'play-guide.md'), moment: slot.moment });
  await startJob(state, slot, input);
}

/** Commits of the judge sides: `A` and `B`. */
function sides(slot: JudgeSlot): { A: string; B: string | null } {
  const { commit, baseline } = slot.pair;
  if (baseline === null) return { A: commit, B: null };
  return slot.side === 'A' ? { A: commit, B: baseline } : { A: baseline, B: commit };
}

/** The degradation of the instances of the baseline commit of a pair. */
function baselineDegrade(pair: JudgePair): Degrade {
  return pair.baselineLatencyMs > 0 ? { inputLatencyMs: pair.baselineLatencyMs } : {};
}

/** The degradation of the instances of side `side` of the judge: that of the baseline commit on its side. */
function sideDegrade(slot: JudgeSlot, side: 'A' | 'B'): Degrade {
  return side !== slot.side ? baselineDegrade(slot.pair) : {};
}

interface JudgeSpec {
  side: 'A' | 'B';
  /** null for the first-screen instance of the side. */
  moment: Moment | null;
  spec: Spec;
}

/**
 * The instances of a judge in the order it plays them (`## how to play` of `judge`), which is the order they start in:
 * the save fixture pairs in moment order, then the first-screen pair; `A` before `B` in each.
 */
function judgeSpecs(plan: JudgingPlan, slot: JudgeSlot): JudgeSpec[] {
  const { A, B } = sides(slot);
  const commits: ['A' | 'B', string][] = B === null ? [['A', A]] : [['A', A], ['B', B]];
  const specs: JudgeSpec[] = [];
  for (const moment of slot.moments) {
    for (const [side, commit] of commits) specs.push({ side, moment, spec: { commit, fixture: fixturePath(plan, moment), ...sideDegrade(slot, side) } });
  }
  for (const [side, commit] of commits) specs.push({ side, moment: null, spec: { commit, ...sideDegrade(slot, side) } });
  return specs;
}

/** The `fixtures` of a judge input: per moment, the instance id of each side (null for one not put in). */
function fixtureEntries(specs: readonly JudgeSpec[], ids: readonly (string | null)[]): { moment: Moment; A: string | null; B: string | null }[] {
  const fixtures: { moment: Moment; A: string | null; B: string | null }[] = [];
  for (const [i, item] of specs.entries()) {
    if (item.moment === null) continue;
    let entry = fixtures.find((f) => f.moment === item.moment);
    if (!entry) fixtures.push((entry = { moment: item.moment, A: null, B: null }));
    entry[item.side] = ids[i] ?? null;
  }
  return fixtures;
}

/**
 * Starts the judge: the first `budget` of its instances (`judgeSpecs`) now, together, and the others into `pending`
 * with ids made now, which its input names; only the pending ones keep the order the judge plays them in.
 */
async function launchJudge(state: State, slot: JudgeSlot): Promise<void> {
  const { plan } = state;
  const specs = judgeSpecs(plan, slot);
  slot.instances = [];
  slot.pending = [];
  slot.released = new Set();
  const ids: (string | null)[] = [];
  const first: Promise<InstanceInfo | null>[] = [];
  for (const [i, item] of specs.entries()) {
    if (i < slot.budget) {
      first.push(start(state, item.spec, slot));
      ids.push(null);
    } else {
      const id = newId();
      slot.pending.push({ id, spec: item.spec });
      ids.push(id);
    }
  }
  const started = await allSettled(first);
  started.forEach((info, i) => {
    ids[i] = info?.id ?? null;
  });
  slot.instances = started.filter((info): info is InstanceInfo => info !== null);
  // the first-screen instance of a side is named whether it started or waits in `pending`; it never fails on a save fixture
  const game = async (side: 'A' | 'B'): Promise<{ instance: string; playGuide: string; names: Record<string, string> | null } | null> => {
    const i = specs.findIndex((s) => s.moment === null && s.side === side);
    const commit = sides(slot)[side];
    return i < 0 || commit === null ? null : { instance: ids[i] as string, ...(await sideOf(state, commit)) };
  };
  const reference = plan.kind === 'fun' || plan.reference === null ? null : { name: plan.reference.name, presentation: plan.reference.presentation, moments: plan.reference.moments };
  const [a, b] = [await game('A'), await game('B')];
  const input = inputFile(state, 'judge', { A: a, B: b, fixtures: fixtureEntries(specs, ids), elements: elementsOf(plan.kind), reference });
  slot.input = input;
  await startJob(state, slot, input);
}

/**
 * Starts a pending instance of a running judge. An instance whose save fixture step failed is noted for `ogw instance
 * wait`, which tells the judge it is not put in. One the judge no longer gets (it gave it back, or its agent ended while
 * the instance started) is stopped.
 */
async function startPendingOne(state: State, slot: JudgeSlot, next: PendingInstance): Promise<void> {
  const job = slot.job as string;
  slot.inFlight.add(next.id);
  let info: InstanceInfo | null;
  try {
    info = await start(state, { ...next.spec, id: next.id }, slot);
  } finally {
    slot.inFlight.delete(next.id);
  }
  if (!state.active.includes(slot) || slot.job !== job || slot.released.has(next.id)) {
    await stop(state, info);
    return;
  }
  if (info) slot.instances.push(info);
  else await noteUnstarted(state.ctx.env, job, next.id, 'its save fixture step failed');
}

async function launch(state: State, slot: Slot): Promise<void> {
  checkStopped(state);
  if (slot.role === 'play') await launchPlay(state, slot);
  else await launchJudge(state, slot);
}

/** The slots a holder keeps: its instances, and a running judge also the slots for its pending instances up to its budget. */
function kept(holder: Slot): number {
  if (holder.role === 'play') return Math.max(holder.live, holder.reserved);
  return Math.max(holder.live, holder.reserved, Math.min(holder.budget, holder.instances.length + holder.starting + holder.pending.length));
}

/**
 * The slots free beside the running instances of other runs: `free` beside the slots the holders of this run keep, for
 * a group; `actual` beside their instances alone, for a pending instance of a running judge, which takes a slot its judge
 * keeps. `kept` is true when a holder of this run keeps a slot.
 */
async function roomOf(state: State, max: number): Promise<{ free: number; actual: number; kept: boolean }> {
  const listed = await listInstances(state.ctx);
  const others = listed.filter((i) => !state.instances.has(i.id) && !state.starting.has(i.id)).length;
  let live = 0;
  let keeps = 0;
  for (const holder of state.all) {
    live += holder.live;
    keeps += kept(holder);
  }
  return { free: max - others - keeps, actual: max - others - live, kept: keeps > 0 };
}

/**
 * Notes a group that does not fit. While this run holds no instance, none of its own stops frees a slot: the wait ends
 * in a failure after `instanceWaitTimeoutMs`, like an instance start that waits for a slot.
 */
function waitForRoom(state: State, size: number): void {
  if (state.all.some((holder) => holder.live > 0)) {
    endRoomWait(state);
    return;
  }
  const now = evaluateDeps.now();
  if (state.waitingSince === null) state.roomWait = openWait(state.slotsName);
  state.waitingSince ??= now;
  const waitMs = state.plan.settings.instanceWaitTimeoutMs;
  if (now - state.waitingSince >= waitMs) {
    throw new OgwError(`instance start failed: no room for ${String(size)} instances within instanceWaitTimeoutMs (${String(waitMs)} ms)`);
  }
}

/** The wait for room among the instances of other runs ends: a holder of the run has an instance, or a group started. */
function endRoomWait(state: State): void {
  state.waitingSince = null;
  state.roomWait?.end();
  state.roomWait = undefined;
}

/**
 * Runs `work` of a play or judge in its step span, which starts at its first work and ends once it has its entry, so
 * that its instance starts and its agent jobs are in it (ogw.md `## time`).
 */
function inSlot(slot: Slot, work: () => Promise<void>): () => Promise<void> {
  return async () => {
    slot.span ??= openSpan(slot.role === 'play' ? 'play' : `judge ${slot.kind}`);
    const open = slot.span;
    try {
      await open.run(work);
    } catch (error) {
      open.end(true);
      throw error;
    }
    if (slot.entry !== null) open.end(slot.entry.status === 'failed');
  };
}

/** Throws when a signal stopped the run or work of it failed: the work in flight then makes nothing new. */
function checkStopped(state: State): void {
  if (state.stoppedBy !== null) throw new OgwError(`ogw loop evaluate stopped by ${state.stoppedBy}`);
  if (state.failure !== null) throw new OgwError('ogw loop evaluate stopped after a failure');
}

/** Throws the signal stop of the run, or else the first failure of its work. */
function checkRun(state: State): void {
  if (state.stoppedBy !== null) throw new OgwError(`ogw loop evaluate stopped by ${state.stoppedBy}`);
  if (state.failure !== null) throw state.failure.error;
}

/** The room an admission pass takes from: the slots free for a group and for a pending instance, and whether this run keeps one. */
interface Room {
  max: number | null;
  /** Free beside the slots the holders of this run keep: for a group. */
  free: number;
  /** Free beside their instances alone: for a pending instance of a running judge, which takes a slot its judge keeps. */
  actual: number;
  /** True when a holder of this run keeps a slot. */
  kept: boolean;
}

/**
 * Whether a group of `size` fits. One larger than `maxConcurrentInstances` never fits: it starts once this run
 * holds no instance, and `startInstance` waits for each slot.
 */
function fits(room: Room, size: number): boolean {
  if (room.max === null) return true;
  return size > room.max ? !room.kept : size <= room.free;
}

function take(room: Room, size: number): void {
  room.free -= size;
  room.actual -= size;
  room.kept = true;
}

/** Starts the next pending instances of the running judges in the slots they keep, while a slot is free. */
function admitPending(state: State, room: Room): void {
  for (const slot of [...state.active]) {
    if (slot.role !== 'judge') continue;
    while (slot.pending.length > 0 && slot.instances.length + slot.starting < slot.budget && room.actual > 0) {
      room.actual--;
      const next = slot.pending.shift() as PendingInstance;
      spawn(state, inSlot(slot, () => startPendingOne(state, slot, next)));
    }
  }
}

/** Starts the queued groups in order; a group that does not fit, or one whose gate is still pending, stops the starts. */
function admitGroups(state: State, room: Room): void {
  for (let i = 0; i < state.queue.length; ) {
    const group = state.queue[i] as Group;
    const gate = group.gate === 'success' ? state.successGate : 'open';
    if (gate === 'closed') {
      state.queue.splice(i, 1);
      continue;
    }
    if (gate === 'pending') return;
    if (!fits(room, group.size)) {
      waitForRoom(state, group.size);
      return;
    }
    endRoomWait(state);
    state.queue.splice(i, 1);
    take(room, group.size);
    for (const slot of group.slots) spawn(state, inSlot(slot, () => launch(state, slot)));
  }
}

/**
 * Starts what fits now, every start beside the others (ogw.md `## loop evaluate`): first the next instances of the
 * running judges in the slots they keep, then the queued groups in order.
 */
async function admit(state: State): Promise<void> {
  const max = state.plan.settings.maxConcurrentInstances;
  const counted = max === null ? null : await roomOf(state, max);
  checkRun(state);
  const room: Room = { max, free: counted?.free ?? Number.POSITIVE_INFINITY, actual: counted?.actual ?? Number.POSITIVE_INFINITY, kept: counted?.kept ?? false };
  admitPending(state, room);
  admitGroups(state, room);
}

function rel(state: State, path: string | null): string {
  return path === null ? '' : relative(state.plan.game.root, path);
}

async function expectedOutput(state: State, job: string): Promise<string | null> {
  const meta = (await readJob(job, state.ctx.env)).meta;
  return typeof meta.output === 'string' ? meta.output : null;
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n', 1)[0] as string;
}

/** The handler of a sleep that a wake may end early: its `AbortError` ends the sleep, any other error is thrown. */
function whenAborted(error: unknown): void {
  if (error instanceof Error && error.name === 'AbortError') return;
  throw error;
}

/**
 * Adds the telemetry summary to the feedback and collects the measure raw data. A client that crashed or hung during
 * the play cannot answer: the feedback gets `- telemetry: unknown (<error>)` and the instance gives no raw data, which
 * the log says with the error.
 */
async function finishPlay(state: State, slot: PlaySlot, output: string): Promise<void> {
  const instance = slot.instance as InstanceInfo;
  const summary = await telemetrySummary(state.ctx, instance.id).catch((error: unknown) => [`- telemetry: unknown (${firstLine(error)})`]);
  await writeFileAtomic(output, appendCoverage(await readFile(output, 'utf8'), summary));
  if (slot.measure) {
    const out = state.plan.site.measure(instance.id);
    const collected = await collectMeasure(state.ctx, state.plan.game.name, instance.id, out).then(
      () => true,
      (error: unknown) => {
        state.ctx.log(`measure: no raw data of instance ${instance.id}: ${firstLine(error)}`);
        return false;
      },
    );
    if (collected) slot.measureFile = out;
  }
  await stop(state, instance);
  slot.entry = { result: rel(state, output), instance: instance.id, platform: slot.platform, moment: slot.moment?.name ?? null, status: 'done' };
}

function judgeAgentOf(agent: AgentSettings): JudgeAgent {
  return { cli: agent.cli ?? 'claude-code', model: agent.model, effort: agent.effort };
}

function judgeEntry(state: State, slot: JudgeSlot, output: string | null, verdict: JudgeVerdict | null): JudgeEntry {
  const { A, B } = sides(slot);
  return {
    kind: slot.kind,
    result: rel(state, output),
    agent: judgeAgentOf(slot.agent),
    A,
    B,
    instanceSide: slot.side,
    omittedMoments: slot.omitted,
    votes: verdict?.votes ?? null,
    lostMoments: verdict?.lostMoments ?? [],
    vsReference: state.plan.kind === 'fun' ? null : (verdict?.vsReference ?? 'unknown'),
    status: verdict ? 'done' : 'failed',
  };
}

/** The step 4 judges together (ogw.md `## loop evaluate`): the votes, `vs baseline` and `vs reference`. */
export function together(plan: Pick<EvaluatePlan, 'baseline' | 'kind' | 'settings'>, main: readonly JudgeEntry[]): Pick<EvaluateFile, 'votes' | 'vsBaseline' | 'vsReference'> {
  const votes = plan.baseline === null ? null : countVotes(main, elementsOf(plan.kind), plan.settings.loop.judgeVotes);
  const vsBaseline: VsBaseline | null = votes === null ? null : combinedVsBaseline(votes, main.some((j) => j.lostMoments.length > 0));
  const vsReference: VsReference | null = plan.kind === 'fun' ? null : combinedVsReference(main);
  return { votes, vsBaseline, vsReference };
}

function mainEntries(state: State): JudgeEntry[] | null {
  const main = state.all.filter((s): s is JudgeSlot => s.role === 'judge' && s.kind === 'main');
  return main.every((s) => s.entry !== null) ? main.map((s) => s.entry as JudgeEntry) : null;
}

/**
 * Opens or closes the success judges once every step 4 judge ended (ogw.md `## loop evaluate`); closes them after a success
 * judge that did not pass.
 */
function updateSuccessGate(state: State, slot: JudgeSlot, entry: JudgeEntry): void {
  if (slot.kind === 'success') {
    if (entry.vsReference !== 'pass') state.successGate = 'closed';
    return;
  }
  const main = mainEntries(state);
  if (main === null) return;
  state.successGate = state.plan.successOpen?.(main) === true ? 'open' : 'closed';
}

/** Stops every instance of a judge, all at once. */
async function stopJudgeInstances(state: State, slot: JudgeSlot): Promise<void> {
  const job = slot.job;
  const instances = slot.instances;
  slot.pending = [];
  slot.instances = [];
  await allSettled(instances.map((instance) => stop(state, instance)));
  if (job !== null) await clearUnstarted(state.ctx.env, job);
}

/**
 * Reads the judge result as its judge input sets (ogw.md `## loop evaluate`): the input file the judge got, not the
 * pair, says whether it compared with the baseline game and with the reference game. Null when its tables cannot be read
 * (`judgeResultErrors`); a file that cannot be read fails.
 */
async function readVerdict(slot: JudgeSlot, output: string): Promise<JudgeVerdict | null> {
  const reading = judgeReadingOf(JSON.parse(await readFile(slot.input as string, 'utf8')));
  const text = await readFile(output, 'utf8');
  if (judgeResultErrors(text, reading).length > 0) return null;
  return judgeVerdict(text, slot.side, { ...reading, judgeMoments: slot.moments.map((m) => m.name) });
}

/**
 * Stops the instances of a slot and calls its agent again on new instances. It keeps its slots meanwhile, so that no
 * group starts in the slots its stops free.
 */
async function relaunch(state: State, slot: Slot): Promise<void> {
  slot.reserved = slot.role === 'play' ? 1 : slot.budget;
  try {
    if (slot.role === 'play') await stop(state, slot.instance);
    else await stopJudgeInstances(state, slot);
    // the starts of the call count in the slot from the call on
    const launched = launch(state, slot);
    slot.reserved = 0;
    await launched;
  } finally {
    slot.reserved = 0;
  }
}

async function retryOrFail(state: State, slot: Slot): Promise<void> {
  const output = slot.job === null ? null : await expectedOutput(state, slot.job);
  if (slot.attempts < state.plan.settings.backgroundRetryLimit) {
    slot.attempts++;
    await relaunch(state, slot);
    return;
  }
  if (slot.role === 'play') await stop(state, slot.instance);
  else await stopJudgeInstances(state, slot);
  if (slot.role === 'play') {
    slot.entry = { result: rel(state, output), instance: slot.instance?.id ?? '', platform: slot.platform, moment: slot.moment?.name ?? null, status: 'failed' };
  } else {
    slot.entry = judgeEntry(state, slot, output, null);
    updateSuccessGate(state, slot, slot.entry);
  }
}

/**
 * Stops the instances a judge released with `ogw instance release`, all at once beside the polls, so a waiting group
 * can start. A pending instance given back is never started; one whose start runs is stopped once it started.
 */
async function carryOutReleases(state: State, slot: JudgeSlot): Promise<void> {
  const job = slot.job as string;
  const ids = new Set(await takeReleases(state.ctx.env, job));
  if (ids.size === 0) return;
  const released = slot.instances.filter((instance) => ids.has(instance.id));
  slot.instances = slot.instances.filter((instance) => !ids.has(instance.id));
  const dropped = slot.pending.filter((p) => ids.has(p.id));
  slot.pending = slot.pending.filter((p) => !ids.has(p.id));
  const starting = [...ids].filter((id) => slot.inFlight.has(id));
  for (const id of ids) slot.released.add(id);
  for (const instance of released) spawn(state, () => stop(state, instance));
  for (const id of [...released.map((i) => i.id), ...dropped.map((p) => p.id), ...starting]) await noteUnstarted(state.ctx.env, job, id, 'it was given back');
}

/** Polls one running agent: carries out its releases, and finishes it beside the polls once it ended. */
async function poll(state: State, slot: Slot): Promise<void> {
  if (slot.role === 'judge') await carryOutReleases(state, slot);
  const job = slot.job as string;
  const outcome = await agentOutcome(state.ctx, job);
  if (outcome.status === 'running') return;
  state.active.splice(state.active.indexOf(slot), 1);
  spawn(state, inSlot(slot, () => finish(state, slot, job, outcome)));
}

/** The work after an agent ended: its result, or a call again. */
async function finish(state: State, slot: Slot, job: string, outcome: AgentOutcome): Promise<void> {
  await clearReleases(state.ctx.env, job);
  await clearPlayBudget(state.ctx.env, job);
  if (outcome.status === 'done' && outcome.output !== null && exists(outcome.output)) {
    if (slot.role === 'play') {
      await finishPlay(state, slot, outcome.output);
      return;
    }
    const verdict = await readVerdict(slot, outcome.output);
    if (verdict) {
      // the gate opens before the instances stop: a group it lets start waits for room as any group does
      slot.entry = judgeEntry(state, slot, outcome.output, verdict);
      updateSuccessGate(state, slot, slot.entry);
      await stopJudgeInstances(state, slot);
      return;
    }
  }
  await retryOrFail(state, slot);
}

/**
 * The handler of one cleanup of `abort`: the run already failed or got a signal, and that failure stays its result, so
 * the cleanup that failed is said in the log with its error and the other cleanups go on.
 */
function cleanupFailed(state: State, what: string): (error: unknown) => void {
  return (error: unknown) => {
    state.ctx.log(`${what} failed: ${firstLine(error)}`);
  };
}

/**
 * Kills every agent job and stops every instance of this run, the ones still starting too, all at once. A signal also
 * kills the agent jobs of the feed, whose groups the judging would get.
 */
async function abort(state: State): Promise<void> {
  const graceMs = state.stoppedBy === null ? undefined : SIGNAL_KILL_GRACE_MS;
  const starting = [...state.starting];
  state.starting.clear();
  const fed = state.stoppedBy === null ? [] : (state.plan.feed?.jobs() ?? []);
  await Promise.all([
    ...[...state.jobs, ...fed].map((job) => killJob(job, state.ctx.env, graceMs).catch(cleanupFailed(state, `killing job ${job}`))),
    ...[...state.instances.values()].map((instance) => stop(state, instance).catch(cleanupFailed(state, `stopping instance ${instance.id}`))),
    ...starting.map((id) => stopInstance(state.ctx, id).catch(cleanupFailed(state, `stopping instance ${id}`))),
    ...[...state.jobs].flatMap((job) => [
      clearReleases(state.ctx.env, job).catch(cleanupFailed(state, `clearing the slot releases of job ${job}`)),
      clearUnstarted(state.ctx.env, job).catch(cleanupFailed(state, `clearing the unstarted instances of job ${job}`)),
      clearPlayBudget(state.ctx.env, job).catch(cleanupFailed(state, `clearing the play budget of job ${job}`)),
    ]),
  ]);
}

/**
 * On SIGTERM or SIGINT (the job time limit or `ogw job kill`), runs the cleanup of a failed run before the process
 * ends: the instance supervisors and the agent jobs are detached processes that the signal does not reach. It stops
 * what the run holds, then waits (within `signalSettleMs`) until the run ended: an instance or agent job start in
 * flight returns, no other starts, and the run cleans up what that start made.
 */
function abortOnSignal(state: State): () => void {
  const off = evaluateDeps.onSignal((signal) => {
    off();
    // the handler is off from here on: starts in flight may still pass a signal they saw to it
    if (state.stoppedBy !== null) return;
    state.stoppedBy = signal;
    state.wake.abort();
    const settled = Promise.race([state.settled, sleep(evaluateDeps.signalSettleMs, undefined, { ref: false })]);
    void Promise.all([abort(state), settled]).finally(() => {
      evaluateDeps.resignal(signal);
    });
  });
  return off;
}

/** A failure of the feed, which ends the judging as a failure that keeps no ended slot. */
class FeedFailure extends Error {
  readonly error: unknown;
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.error = error;
  }
}

/** Takes the groups that came from the feed into the queue. */
async function takeArrivals(state: State): Promise<void> {
  const feed = state.plan.feed;
  if (feed === undefined || state.feedDone) return;
  const arrived = await feed.next().catch((error: unknown) => {
    throw new FeedFailure(error);
  });
  const slots = arrived.groups.flatMap((g) => g.slots);
  state.queue.push(...arrived.groups);
  state.all.push(...slots);
  await prepareJudges(state, slots);
  state.feedDone = arrived.done;
}

/**
 * Before the judges of `slots` start: the `<game>` of their judge inputs (`sideOf`), so that a judge starts its agent as
 * soon as its instances started.
 */
async function prepareJudges(state: State, slots: readonly Slot[]): Promise<void> {
  const commits = new Set(slots.flatMap((s) => (s.role === 'judge' ? [s.pair.commit, ...(s.pair.baseline === null ? [] : [s.pair.baseline])] : [])));
  await allSettled([...commits].map((commit) => sideOf(state, commit)));
}

/** True when nothing is left to start, run or come. */
function finished(state: State): boolean {
  return state.queue.length === 0 && state.active.length === 0 && state.tasks.size === 0 && (state.plan.feed === undefined || state.feedDone);
}

/**
 * Polls the running agents and starts what fits, while the starts, stops and finishing work run beside the polls. Each instance start or stop and each such work that ends wakes the wait between polls. On a failure or a
 * signal, the work in flight stops at its next step and cleans up what it made before the failure is thrown.
 */
async function runSlots(state: State): Promise<void> {
  try {
    for (;;) {
      checkRun(state);
      const nudged = new AbortController();
      state.nudge = nudged;
      // a poll only reads, so the polls go one after another and none runs after a signal
      for (const slot of [...state.active]) {
        checkRun(state);
        await poll(state, slot);
      }
      await takeArrivals(state);
      checkRun(state);
      await admit(state);
      if (finished(state)) break;
      await sleep(evaluateDeps.pollMs, undefined, { signal: AbortSignal.any([state.wake.signal, nudged.signal]) }).catch(whenAborted);
    }
  } catch (error) {
    state.wake.abort();
    await settleTasks(state);
    throw state.stoppedBy === null && state.failure !== null ? state.failure.error : error;
  }
  checkStopped(state);
}

/**
 * Why the step 4 judges did not get `memorable_moment` when it was asked for, in a completeness iteration: `missing`
 * without its `## judge moments` line or its save fixture at the work branch HEAD, `omitted` when the judges did not put
 * it in (they all put in the same moments). undefined otherwise.
 */
function memorableMomentGap(plan: EvaluatePlan, judges: readonly JudgeEntry[]): EvaluateFile['memorableMoment'] {
  if (!plan.memorableMoment || plan.kind === 'fun') return undefined;
  const fixture = plan.fixtureDir === undefined ? false : exists(join(plan.fixtureDir, `${MEMORABLE_MOMENT}.json`));
  if (!fixture || !plan.moments.some((m) => m.name === MEMORABLE_MOMENT)) return 'missing';
  return judges.find((j) => j.kind === 'main')?.omittedMoments.includes(MEMORABLE_MOMENT) === true ? 'omitted' : undefined;
}

function entries(slots: readonly Slot[]): { plays: PlayEntry[]; judges: JudgeEntry[] } {
  const plays: PlayEntry[] = [];
  const judges: JudgeEntry[] = [];
  for (const slot of slots) {
    if (slot.role === 'play' && slot.entry) plays.push(slot.entry);
    if (slot.role === 'judge' && slot.entry) judges.push(slot.entry);
  }
  return { plays, judges };
}

/** `ogw loop evaluate`: steps 3 and 4 and the success judges. Writes and commits `evaluate-<n>.json`. */
export async function evaluate(ctx: Context, given: EvaluatePlan): Promise<{ file: EvaluateFile; path: string }> {
  const fixtureDir = await fixturesAtHead(ctx, given);
  try {
    return await evaluateWith(ctx, { ...given, fixtureDir });
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

/** The judging site of a run: its files in `records/loops/<run>/evidence/`, and the judge agents of the open run. */
function runSite(game: GameRepo, run: RunState): EvaluateSite {
  const n = String(run.iteration);
  return {
    input: (role, ms) => abs(game, runRel(run, `evidence/input-${role}-${n}-${String(ms)}.json`)),
    measure: (instance) => abs(game, runRel(run, `evidence/measure-${n}/${instance}.json`)),
    judgePlace: () => null,
  };
}

/** The judging plan of `ogw loop evaluate`: the success judges open when the rest of a candidate iteration holds. */
function judgingPlanOf(plan: EvaluatePlan): JudgingPlan {
  return {
    game: plan.game,
    kind: plan.kind,
    moments: plan.moments,
    reference: plan.reference,
    settings: plan.settings,
    ...(plan.fixtureDir === undefined ? {} : { fixtureDir: plan.fixtureDir }),
    site: runSite(plan.game, plan.run),
    successOpen: (main) => successPrecondition({ kind: plan.kind, ...together(plan, main) }, (name) => checkResult(plan.check, name)),
  };
}

/**
 * Runs the groups (judges and plays) in order within `maxConcurrentInstances`, and returns every slot with its entry. On a failure or a signal it stops what it started and throws.
 */
export async function runJudging(ctx: Context, plan: JudgingPlan, queue: Group[]): Promise<Slot[]> {
  return (await judging(ctx, plan, queue, false)).slots;
}

/**
 * As `runJudging`, but on a failure other than a signal or one of the feed it stops what it started and returns every
 * slot with the failure: the slots that ended before it keep their entries, the others have none.
 */
export async function runJudgingKeepingEnded(ctx: Context, plan: JudgingPlan, queue: Group[]): Promise<{ slots: Slot[]; failure: string | null }> {
  return judging(ctx, plan, queue, true);
}

async function judging(ctx: Context, plan: JudgingPlan, queue: Group[], keep: boolean): Promise<{ slots: Slot[]; failure: string | null }> {
  const state: State = {
    ctx,
    plan,
    queue,
    all: queue.flatMap((g) => g.slots),
    active: [],
    instances: new Map(),
    owners: new Map(),
    starting: new Set(),
    jobs: new Set(),
    successGate: 'pending',
    lastInputMs: 0,
    waitingSince: null,
    slotsName: join(await instancesDir(ctx.env), 'slots'),
    stoppedBy: null,
    failure: null,
    wake: new AbortController(),
    nudge: new AbortController(),
    tasks: new Set(),
    feedDone: false,
    settled: Promise.resolve(),
    guides: null,
    sides: new Map(),
  };
  let settle = (): void => undefined;
  state.settled = new Promise((resolve) => {
    settle = resolve;
  });
  const off = abortOnSignal(state);
  let failure: string | null = null;
  try {
    await span('prepare judges', () => prepareJudges(state, state.all));
    await runSlots(state);
  } catch (error) {
    await abort(state);
    const thrown = error instanceof FeedFailure ? error.error : error;
    if (!keep || state.stoppedBy !== null || error instanceof FeedFailure) throw thrown;
    failure = thrown instanceof Error ? thrown.message : String(thrown);
  } finally {
    endRoomWait(state);
    settle();
    off();
    if (state.guides !== null) await rm(await state.guides, { recursive: true, force: true });
  }
  return { slots: state.all, failure };
}

async function evaluateWith(ctx: Context, plan: EvaluatePlan): Promise<{ file: EvaluateFile; path: string }> {
  const slots = await span('judging', () => runJudging(ctx, judgingPlanOf(plan), planGroups(plan)));
  return span('record', () => recordEvaluation(ctx, plan, slots));
}

/** Collects the measure data, writes and commits `evaluate-<n>.json` with the results of the plays and judges. */
async function recordEvaluation(ctx: Context, plan: EvaluatePlan, slots: readonly Slot[]): Promise<{ file: EvaluateFile; path: string }> {
  const n = String(plan.run.iteration);
  const measureRel = runRel(plan.run, `measure-${n}.json`);
  const hadMeasure = exists(abs(plan.game, measureRel));
  let measure: string | null = null;
  const measureFiles = slots.flatMap((s) => (s.role === 'play' && s.measureFile !== null ? [s.measureFile] : []));
  if (measureFiles.length > 0) measure = relative(plan.game.root, resolve(plan.game.root, (await measureCollected(ctx, plan.game.name, measureFiles)).path));
  else await rm(abs(plan.game, measureRel), { force: true });
  const { plays, judges } = entries(slots);
  const gap = memorableMomentGap(plan, judges);
  const file: EvaluateFile = {
    commit: plan.commit,
    baseline: plan.baseline,
    kind: plan.kind,
    elements: elementsOf(plan.kind),
    plays,
    judges,
    ...together(plan, judges.filter((j) => j.kind === 'main')),
    measure,
    ...(gap === undefined ? {} : { memorableMoment: gap }),
  };
  const path = runRel(plan.run, `evaluate-${n}.json`);
  await writeJsonAtomic(abs(plan.game, path), file);
  const written = [measure, ...plays.map((p) => p.result), ...judges.map((j) => j.result)];
  const paths = written.filter((r): r is string => r !== null && r !== '' && exists(abs(plan.game, r)));
  if (measure === null && hadMeasure) paths.push(measureRel);
  await commitPaths(plan.game.root, [path, ...paths], `loop ${plan.run.name}: evaluate ${n}`, { env: ctx.env });
  return { file, path };
}
