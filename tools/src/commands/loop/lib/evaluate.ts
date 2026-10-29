import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { commitPaths, showFile } from '../../../lib/git.ts';
import { killJob, readJob } from '../../../lib/jobs.ts';
import type { RunState } from '../../../lib/runstate.ts';
import type { AgentSettings, HarnessSettings } from '../../../lib/settings.ts';
import { agentOutcome, startAgentJob, type CalibrationPlace } from '../../agent/api.ts';
import { listInstances, startInstance, stopInstance, type InstanceInfo, type InstanceOptions, type StartFailure } from '../../instance/api.ts';
import { clearReleases, takeReleases } from '../../instance/lib/releases.ts';
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
  type PlayEntry,
  type VsBaseline,
  type VsReference,
} from './files.ts';
import { appendCoverage, judgeVerdict, type JudgeVerdict } from './results.ts';
import { abs, runRel } from './run.ts';
import { botRun, comparisonText, scenarioAtHead, withInputLatency, type BotRun } from './shared-telemetry.ts';
import { BOT_PLAYTEST_POLL_MS } from '../../check/lib/bot-playtest.ts';
import type { Scenario } from '../../check/lib/scenario.ts';
import { combinedVsBaseline, combinedVsReference, countVotes } from './votes.ts';
import { MEMORABLE_MOMENT, type Moment, type Reference } from './setup.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;
/** Grace time of each agent job kill when a signal stops `ogw loop evaluate`: the job supervisor kills it 5000 ms after SIGTERM. */
const SIGNAL_KILL_GRACE_MS = 2000;

/** Dependencies tests replace: the A/B coin, the poll intervals, the clock, and the signal handling. */
export const evaluateDeps = {
  /** Returns a number in [0, 1); below 0.5 puts this commit's instance in `A`. */
  random: Math.random,
  pollMs: 5000,
  /** The poll interval of the shared-telemetry bot runs: that of the bot playtest. */
  botPollMs: BOT_PLAYTEST_POLL_MS,
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
  db: 'postgresql' | undefined;
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
  /** Absolute path of the shared telemetry comparison of the k-th step 4 judge of the pair. */
  telemetry(pair: JudgePair, k: number): string;
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
  db: 'postgresql' | undefined;
  fixtureDir?: string;
  site: EvaluateSite;
  /** Whether the success judges start, once every step 4 judge ended; absent: no success judge opens. */
  successOpen?: (main: readonly JudgeEntry[]) => boolean;
}

/** An instance to start. A start that fails for another reason than a save fixture step ends `ogw loop evaluate`. */
interface Spec {
  commit: string;
  platform?: string;
  fixture?: string;
  /** The headless instance of a bot run (the shared telemetry). */
  headless?: boolean;
  /** `--input-latency` of the instance; absent or 0 for none. */
  inputLatencyMs?: number;
}

interface PlaySlot {
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

export interface JudgeSlot {
  role: 'judge';
  kind: 'main' | 'success';
  pair: JudgePair;
  /** The order of a step 4 judge from 1; 0 for a success judge. */
  k: number;
  agent: AgentSettings;
  /** Absolute path of the judge input `telemetry`, or null. */
  telemetry: string | null;
  side: 'A' | 'B';
  moments: Moment[];
  omitted: string[];
  attempts: number;
  instances: InstanceInfo[];
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
  active: Slot[];
  /** Every instance started and not stopped yet. */
  instances: Map<string, InstanceInfo>;
  /** Ids of the instances whose `startInstance` reserved a slot and has not returned yet. */
  starting: Set<string>;
  jobs: Set<string>;
  successGate: 'pending' | 'open' | 'closed';
  lastInputMs: number;
  /** When the first queued group began waiting for room while this run held no instance; null when not waiting. */
  waitingSince: number | null;
  /** The signal that stopped this run; null while it runs. */
  stoppedBy: NodeJS.Signals | null;
  /** Aborted on the signal: ends the wait between polls. */
  wake: AbortController;
  /** Resolves when `runSlots` ended and the run cleaned up after a failure. */
  settled: Promise<void>;
}

function fixturePath(plan: Pick<JudgingPlan, 'fixtureDir'>, moment: Moment): string {
  if (plan.fixtureDir === undefined) throw new OgwError('the save fixtures of the work branch HEAD were not taken');
  return join(plan.fixtureDir, `${moment.name}.json`);
}

/**
 * Writes `client/dev/bot/fixtures/<moment>.json` of the work branch HEAD into a new temp folder for every
 * moment: every save fixture instance, whatever its commit, gets that file (`game-loop` `## iteration` 3).
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

/** Instances of one judge: this commit and the baseline, then a pair per judge moment, within `maxConcurrentInstances`. */
export function judgeGroup(plan: Pick<JudgingPlan, 'moments' | 'settings'>, pair: JudgePair, kind: 'main' | 'success', k: number, side: 'A' | 'B', agent: AgentSettings): Group {
  const { included, omitted, size } = judgeMoments(plan, pair);
  const slot: JudgeSlot = { role: 'judge', kind, pair, k, agent, telemetry: null, side, moments: included, omitted, attempts: 0, instances: [], job: null, entry: null };
  return { size, slots: [slot], gate: kind === 'success' ? 'success' : 'none' };
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
  return { role: 'play', spec, platform, moment, measure, measureFile: null, attempts: 0, instance: null, job: null, entry: null };
}

/**
 * Groups in start order (`game-loop` `## iteration` 3): each step 4 judge (`loop.judgeVotes` with a baseline game,
 * else one; the first on a random side, each next on the other side), the `playInstances` plays, a play per judge
 * moment, and in a completeness iteration of a loop run the success judges (a random side each, with the agent of the
 * first step 4 judge).
 */
export function planGroups(plan: EvaluatePlan): Group[] {
  const groups: Group[] = [];
  const pair: JudgePair = { name: '', commit: plan.commit, baseline: plan.baseline, baselineLatencyMs: 0 };
  const count = plan.baseline === null ? 1 : plan.settings.loop.judgeVotes;
  const first = plan.baseline === null ? 'A' : drawSide();
  for (let k = 1; k <= count; k++) {
    groups.push(judgeGroup(plan, pair, 'main', k, alternateSide(first, k), judgeAgent(plan.settings, k)));
  }
  const plays: Slot[] = [];
  // no play agent plays in a fun iteration: its findings would wait for a completeness iteration, and the bot playtest gates blockers
  for (let k = 0; k < (plan.kind === 'fun' ? 0 : plan.settings.playInstances); k++) {
    const platform = plan.platforms[k % plan.platforms.length] as string;
    plays.push(playSlot({ commit: plan.commit, platform }, platform, null, true));
  }
  if (plays.length > 0) groups.push({ size: plays.length, slots: plays, gate: 'none' });
  const firstPlatform = plan.platforms[0] as string;
  for (const moment of plan.kind === 'fun' ? [] : plan.moments) {
    groups.push({ size: 1, slots: [playSlot({ commit: plan.commit, fixture: fixturePath(plan, moment) }, firstPlatform, moment, false)], gate: 'none' });
  }
  if (plan.run.kind === 'loop' && plan.kind === 'completeness') {
    for (let i = 0; i < plan.settings.loopStop.successJudges; i++) {
      groups.push(judgeGroup(plan, pair, 'success', 0, plan.baseline === null ? 'A' : drawSide(), judgeAgent(plan.settings, 1)));
    }
  }
  return groups;
}

async function inputFile(state: State, role: 'play' | 'judge', input: unknown): Promise<string> {
  let ms = evaluateDeps.now();
  if (ms <= state.lastInputMs) ms = state.lastInputMs + 1;
  state.lastInputMs = ms;
  const path = state.plan.site.input(role, ms);
  await writeJsonAtomic(path, input);
  return path;
}

/** `reason` of the `StartFailure` data of a `startInstance` error, or null. */
function startFailureReason(error: unknown): StartFailure['reason'] | null {
  return error instanceof OgwError ? ((error.data as Partial<StartFailure> | undefined)?.reason ?? null) : null;
}

/** Starts an instance; null when a save fixture step failed (`game-loop` "An instance that could not be started with its save fixture is not put in"). */
async function start(state: State, spec: Spec): Promise<InstanceInfo | null> {
  checkStopped(state);
  const options: InstanceOptions = { game: state.plan.game.name, commit: spec.commit, client: spec.headless === true ? 'headless' : 'window' };
  if (spec.platform !== undefined) options.platform = spec.platform;
  if (spec.fixture !== undefined) options.fixture = spec.fixture;
  else if (spec.headless !== true) options.played = true;
  if (state.plan.db) options.db = state.plan.db;
  if (spec.inputLatencyMs !== undefined && spec.inputLatencyMs > 0) options.inputLatencyMs = spec.inputLatencyMs;
  const reserved: string[] = [];
  try {
    // A signal ends a wait for a slot without one, and stops an instance start that reserved one at its next step.
    const info = await startInstance(state.ctx, options, {
      signal: state.wake.signal,
      onReserved: (id) => {
        reserved.push(id);
        state.starting.add(id);
      },
    });
    state.instances.set(info.id, info);
    return info;
  } catch (error) {
    checkStopped(state);
    if (startFailureReason(error) === 'fixture') return null;
    throw new OgwError(`instance start failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const id of reserved) state.starting.delete(id);
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

async function stop(state: State, instance: InstanceInfo | null): Promise<void> {
  if (!instance || !state.instances.has(instance.id)) return;
  state.instances.delete(instance.id);
  await stopInstance(state.ctx, instance.id);
}

function guide(instance: InstanceInfo | null): { instance: string; playGuide: string } | null {
  return instance ? { instance: instance.id, playGuide: join(instance.root, 'play-guide.md') } : null;
}

async function launchPlay(state: State, slot: PlaySlot): Promise<void> {
  slot.instance = await start(state, slot.spec);
  if (!slot.instance) {
    slot.entry = { result: '', instance: '', platform: slot.platform, moment: slot.moment?.name ?? null, status: 'failed' };
    return;
  }
  const input = await inputFile(state, 'play', { instance: slot.instance.id, playGuide: join(slot.instance.root, 'play-guide.md'), moment: slot.moment });
  await startJob(state, slot, input);
}

/** Commits of the judge sides: `A` and `B`. */
function sides(slot: JudgeSlot): { A: string; B: string | null } {
  const { commit, baseline } = slot.pair;
  if (baseline === null) return { A: commit, B: null };
  return slot.side === 'A' ? { A: commit, B: baseline } : { A: baseline, B: commit };
}

/** The `--input-latency` of the instances of side `side` of the judge: that of the baseline commit on its side. */
function sideLatency(slot: JudgeSlot, side: 'A' | 'B'): { inputLatencyMs?: number } {
  const latency = slot.pair.baselineLatencyMs;
  return latency > 0 && side !== slot.side ? { inputLatencyMs: latency } : {};
}

async function launchJudge(state: State, slot: JudgeSlot): Promise<void> {
  const { plan } = state;
  const { A, B } = sides(slot);
  const a = await start(state, { commit: A, ...sideLatency(slot, 'A') });
  const b = B === null ? null : await start(state, { commit: B, ...sideLatency(slot, 'B') });
  const fixtures: { moment: Moment; A: string | null; B: string | null }[] = [];
  slot.instances = [a, b].filter((i): i is InstanceInfo => i !== null);
  for (const moment of slot.moments) {
    const fa = await start(state, { commit: A, fixture: fixturePath(plan, moment), ...sideLatency(slot, 'A') });
    const fb = B === null ? null : await start(state, { commit: B, fixture: fixturePath(plan, moment), ...sideLatency(slot, 'B') });
    slot.instances.push(...[fa, fb].filter((i): i is InstanceInfo => i !== null));
    fixtures.push({ moment, A: fa?.id ?? null, B: fb?.id ?? null });
  }
  const reference = plan.kind === 'fun' || plan.reference === null ? null : { name: plan.reference.name, presentation: plan.reference.presentation, moments: plan.reference.moments };
  const input = await inputFile(state, 'judge', { A: guide(a), B: guide(b), fixtures, elements: elementsOf(plan.kind), telemetry: slot.telemetry, reference });
  await startJob(state, slot, input);
}

async function launch(state: State, slot: Slot): Promise<void> {
  checkStopped(state);
  if (slot.role === 'play') await launchPlay(state, slot);
  else await launchJudge(state, slot);
}

/**
 * True when the group fits beside every running instance, this run's and others'. A group larger than
 * `maxConcurrentInstances` never fits: it starts once this run holds no instance, and `startInstance` waits for each slot.
 */
async function hasRoom(state: State, size: number): Promise<boolean> {
  const max = state.plan.settings.maxConcurrentInstances;
  if (max === null) return true;
  if (size > max) return state.instances.size === 0;
  return (await listInstances(state.ctx)).length + size <= max;
}

/**
 * Notes a group that does not fit. While this run holds no instance, none of its own stops frees a slot: the wait ends
 * in a failure after `instanceWaitTimeoutMs`, like an instance start that waits for a slot.
 */
function waitForRoom(state: State): void {
  if (state.instances.size > 0) {
    state.waitingSince = null;
    return;
  }
  const now = evaluateDeps.now();
  state.waitingSince ??= now;
  const waitMs = state.plan.settings.instanceWaitTimeoutMs;
  if (now - state.waitingSince >= waitMs) {
    throw new OgwError(`instance start failed: no room for ${String(state.queue[0]?.size ?? 0)} instances within instanceWaitTimeoutMs (${String(waitMs)} ms)`);
  }
}

function checkStopped(state: State): void {
  if (state.stoppedBy !== null) throw new OgwError(`ogw loop evaluate stopped by ${state.stoppedBy}`);
}

/** Starts queued groups in order while they fit. */
async function launchQueued(state: State): Promise<boolean> {
  let launched = false;
  while (state.queue.length > 0) {
    const group = state.queue[0] as Group;
    if (group.gate === 'success' && state.successGate === 'closed') {
      state.queue.shift();
      continue;
    }
    if (group.gate === 'success' && state.successGate === 'pending') break;
    if (!(await hasRoom(state, group.size))) {
      waitForRoom(state);
      break;
    }
    state.waitingSince = null;
    state.queue.shift();
    for (const slot of group.slots) await launch(state, slot);
    launched = true;
  }
  return launched;
}

function rel(state: State, path: string | null): string {
  return path === null ? '' : relative(state.plan.game.root, path);
}

async function expectedOutput(state: State, job: string): Promise<string | null> {
  const meta = (await readJob(job, state.ctx.env).catch(() => null))?.meta;
  return typeof meta?.output === 'string' ? meta.output : null;
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n', 1)[0] as string;
}

/**
 * Adds the telemetry summary to the feedback and collects the measure raw data. A client that crashed or hung during
 * the play cannot answer: the feedback gets `- telemetry: unknown (<error>)` and the instance gives no raw data.
 */
async function finishPlay(state: State, slot: PlaySlot, output: string): Promise<void> {
  const instance = slot.instance as InstanceInfo;
  const summary = await telemetrySummary(state.ctx, instance.id).catch((error: unknown) => [`- telemetry: unknown (${firstLine(error)})`]);
  await writeFileAtomic(output, appendCoverage(await readFile(output, 'utf8'), summary));
  if (slot.measure) {
    const out = state.plan.site.measure(instance.id);
    const collected = await collectMeasure(state.ctx, state.plan.game.name, instance.id, out).then(
      () => true,
      () => false,
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
    telemetry: slot.telemetry,
    status: verdict ? 'done' : 'failed',
  };
}

/** The step 4 judges together (`game-loop` `## iteration` 4): the votes, `vs baseline` and `vs reference`. */
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
 * Opens or closes the success judges once every step 4 judge ended (`game-loop` `## stop`); closes them after a success
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

async function stopJudgeInstances(state: State, slot: JudgeSlot): Promise<void> {
  for (const instance of slot.instances) await stop(state, instance);
  slot.instances = [];
}

/** Reads the judge result; null when its tables cannot be read. */
async function readVerdict(state: State, slot: JudgeSlot, output: string): Promise<JudgeVerdict | null> {
  try {
    return judgeVerdict(await readFile(output, 'utf8'), slot.side, {
      withBaseline: slot.pair.baseline !== null,
      withReference: state.plan.kind === 'completeness',
      elements: elementsOf(state.plan.kind),
      judgeMoments: slot.moments.map((m) => m.name),
    });
  } catch {
    return null;
  }
}

async function retryOrFail(state: State, slot: Slot): Promise<void> {
  const output = slot.job === null ? null : await expectedOutput(state, slot.job);
  if (slot.role === 'play') await stop(state, slot.instance);
  else await stopJudgeInstances(state, slot);
  if (slot.attempts < state.plan.settings.backgroundRetryLimit) {
    slot.attempts++;
    await launch(state, slot);
    return;
  }
  if (slot.role === 'play') {
    slot.entry = { result: rel(state, output), instance: slot.instance?.id ?? '', platform: slot.platform, moment: slot.moment?.name ?? null, status: 'failed' };
  } else {
    slot.entry = judgeEntry(state, slot, output, null);
    updateSuccessGate(state, slot, slot.entry);
  }
}

/** Stops the instances a judge released with `ogw instance release`, so a waiting group can start. True when it stopped one. */
async function carryOutReleases(state: State, slot: JudgeSlot): Promise<boolean> {
  const ids = new Set(await takeReleases(state.ctx.env, slot.job as string));
  const released = slot.instances.filter((instance) => ids.has(instance.id));
  for (const instance of released) await stop(state, instance);
  slot.instances = slot.instances.filter((instance) => !ids.has(instance.id));
  return released.length > 0;
}

/** Polls one running agent. Returns true when it ended or a judge released an instance. */
async function poll(state: State, slot: Slot): Promise<boolean> {
  const released = slot.role === 'judge' ? await carryOutReleases(state, slot) : false;
  const outcome = await agentOutcome(state.ctx, slot.job as string);
  if (outcome.status === 'running') return released;
  await clearReleases(state.ctx.env, slot.job as string);
  state.active.splice(state.active.indexOf(slot), 1);
  if (outcome.status === 'done' && outcome.output !== null && exists(outcome.output)) {
    if (slot.role === 'play') {
      await finishPlay(state, slot, outcome.output);
      return true;
    }
    const verdict = await readVerdict(state, slot, outcome.output);
    if (verdict) {
      await stopJudgeInstances(state, slot);
      slot.entry = judgeEntry(state, slot, outcome.output, verdict);
      updateSuccessGate(state, slot, slot.entry);
      return true;
    }
  }
  await retryOrFail(state, slot);
  return true;
}

/** Kills every agent job and stops every instance of this run, the ones still starting too, all at once. */
async function abort(state: State): Promise<void> {
  const graceMs = state.stoppedBy === null ? undefined : SIGNAL_KILL_GRACE_MS;
  const starting = [...state.starting];
  state.starting.clear();
  await Promise.all([
    ...[...state.jobs].map((job) => killJob(job, state.ctx.env, graceMs).catch(() => undefined)),
    ...[...state.instances.values()].map((instance) => stop(state, instance).catch(() => undefined)),
    ...starting.map((id) => stopInstance(state.ctx, id).catch(() => undefined)),
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
    state.stoppedBy = signal;
    state.wake.abort();
    const settled = Promise.race([state.settled, sleep(evaluateDeps.signalSettleMs, undefined, { ref: false })]);
    void Promise.all([abort(state), settled]).finally(() => {
      evaluateDeps.resignal(signal);
    });
  });
  return off;
}

/** Bot runs of the scenario per commit for the shared telemetry: the spread between them is the noise a difference must exceed. */
const SHARED_TELEMETRY_RUNS = 3;
/** New runs per commit that may replace runs that did not reach every step. */
const SHARED_TELEMETRY_RETRIES = 3;

/** A bot run of the scenario on a new headless instance of `commit`; null when it did not start or reach every step. */
async function botRunOf(state: State, commit: string, scenario: Scenario, inputLatencyMs = 0): Promise<BotRun | null> {
  let instance: InstanceInfo | null = null;
  try {
    instance = await start(state, { commit, headless: true, inputLatencyMs });
    const run = instance === null ? null : await botRun(state.ctx, instance, scenario, evaluateDeps.botPollMs);
    if (run === null) state.ctx.log(`shared telemetry: a bot run of ${commit} did not reach every step`);
    return run;
  } catch (error) {
    checkStopped(state);
    state.ctx.log(`shared telemetry: no bot run of ${commit}: ${firstLine(error)}`);
    return null;
  } finally {
    await stop(state, instance);
  }
}

/**
 * The runs of `commit` that reached every step, with new runs, one at a time, in place of those that did not, up to
 * `SHARED_TELEMETRY_RETRIES` new runs; null when fewer than `SHARED_TELEMETRY_RUNS` runs reached every step.
 */
async function completeRuns(state: State, commit: string, scenario: Scenario, inputLatencyMs: number, first: readonly (BotRun | null)[]): Promise<BotRun[] | null> {
  const runs = first.filter((r): r is BotRun => r !== null);
  for (let retry = 0; runs.length < SHARED_TELEMETRY_RUNS && retry < SHARED_TELEMETRY_RETRIES; retry++) {
    const run = await botRunOf(state, commit, scenario, inputLatencyMs);
    checkStopped(state);
    if (run !== null) runs.push(run);
  }
  return runs.length === SHARED_TELEMETRY_RUNS ? runs : null;
}

/**
 * The shared telemetry of one pair (`game-loop` `## iteration` 4): the bot runs of the scenario on this commit and the
 * baseline commit, compared with `A` and `B` of each step 4 judge of the pair in the site's telemetry file. A success
 * judge gets the file of the first step 4 judge of its side. Without both runs the judges of the pair get `telemetry`
 * null.
 */
async function sharePairTelemetry(state: State, pair: JudgePair, scenario: Scenario): Promise<void> {
  if (pair.baseline === null) return;
  const baseline = pair.baseline;
  const runs = await Promise.all(
    Array.from({ length: SHARED_TELEMETRY_RUNS }, () => [botRunOf(state, pair.commit, scenario), botRunOf(state, baseline, scenario, pair.baselineLatencyMs)]).flat(),
  );
  checkStopped(state);
  const [mine, theirRuns] = await Promise.all([
    completeRuns(state, pair.commit, scenario, 0, runs.filter((_, i) => i % 2 === 0)),
    completeRuns(state, baseline, scenario, pair.baselineLatencyMs, runs.filter((_, i) => i % 2 === 1)),
  ]);
  checkStopped(state);
  if (mine === null || theirRuns === null) return;
  const theirs = theirRuns.map((r) => withInputLatency(r, pair.baselineLatencyMs));
  const judges = state.all.filter((s): s is JudgeSlot => s.role === 'judge' && s.pair === pair);
  for (const slot of judges.filter((j) => j.kind === 'main')) {
    const path = state.plan.site.telemetry(pair, slot.k);
    await writeFileAtomic(path, slot.side === 'A' ? comparisonText(mine, theirs) : comparisonText(theirs, mine));
    slot.telemetry = path;
  }
  for (const slot of judges.filter((j) => j.kind === 'success')) {
    slot.telemetry = judges.find((j) => j.kind === 'main' && j.side === slot.side)?.telemetry ?? null;
  }
}

/** The shared telemetry of every pair with a baseline commit, from the scenario of the checkout HEAD; none without it. */
async function shareTelemetry(state: State): Promise<void> {
  const pairs = [...new Set(state.all.filter((s): s is JudgeSlot => s.role === 'judge').map((s) => s.pair))].filter((p) => p.baseline !== null);
  if (pairs.length === 0) return;
  const scenario = await scenarioAtHead(state.plan.game, state.ctx.env);
  if (scenario === null) return;
  for (const pair of pairs) await sharePairTelemetry(state, pair, scenario);
}

async function runSlots(state: State): Promise<void> {
  while (state.queue.length > 0 || state.active.length > 0) {
    checkStopped(state);
    let changed = await launchQueued(state);
    for (const slot of [...state.active]) {
      checkStopped(state);
      if (await poll(state, slot)) changed = true;
    }
    if (!changed) await sleep(evaluateDeps.pollMs, undefined, { signal: state.wake.signal }).catch(() => undefined);
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
    telemetry: (_pair, k) => abs(game, runRel(run, `evidence/telemetry-${n}-${String(k)}.md`)),
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
    db: plan.db,
    ...(plan.fixtureDir === undefined ? {} : { fixtureDir: plan.fixtureDir }),
    site: runSite(plan.game, plan.run),
    successOpen: (main) => successPrecondition({ kind: plan.kind, ...together(plan, main) }, (name) => checkResult(plan.check, name)),
  };
}

/**
 * Runs the groups (judges and plays) in order within `maxConcurrentInstances`, after the shared telemetry of their pairs,
 * and returns every slot with its entry. On a failure or a signal it stops what it started and throws.
 */
export async function runJudging(ctx: Context, plan: JudgingPlan, queue: Group[]): Promise<Slot[]> {
  return (await judging(ctx, plan, queue, false)).slots;
}

/**
 * As `runJudging`, but on a failure other than a signal it stops what it started and returns every slot with the
 * failure: the slots that ended before it keep their entries, the others have none.
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
    starting: new Set(),
    jobs: new Set(),
    successGate: 'pending',
    lastInputMs: 0,
    waitingSince: null,
    stoppedBy: null,
    wake: new AbortController(),
    settled: Promise.resolve(),
  };
  let settle = (): void => undefined;
  state.settled = new Promise((resolve) => {
    settle = resolve;
  });
  const off = abortOnSignal(state);
  let failure: string | null = null;
  try {
    await shareTelemetry(state);
    await runSlots(state);
  } catch (error) {
    await abort(state);
    if (!keep || state.stoppedBy !== null) throw error;
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    settle();
    off();
  }
  return { slots: state.all, failure };
}

async function evaluateWith(ctx: Context, plan: EvaluatePlan): Promise<{ file: EvaluateFile; path: string }> {
  const slots = await runJudging(ctx, judgingPlanOf(plan), planGroups(plan));
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
  // the telemetry files are evidence, which is not committed
  const paths = written.filter((r): r is string => r !== null && r !== '' && exists(abs(plan.game, r)));
  if (measure === null && hadMeasure) paths.push(measureRel);
  await commitPaths(plan.game.root, [path, ...paths], `loop ${plan.run.name}: evaluate ${n}`, { env: ctx.env });
  return { file, path };
}
