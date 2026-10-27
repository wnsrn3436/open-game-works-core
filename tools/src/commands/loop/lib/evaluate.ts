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
import type { HarnessSettings } from '../../../lib/settings.ts';
import { agentOutcome, startAgentJob } from '../../agent/api.ts';
import { listInstances, startInstance, stopInstance, type InstanceInfo, type InstanceOptions, type StartFailure } from '../../instance/api.ts';
import { collectMeasure, measureCollected } from '../../measure/api.ts';
import { telemetrySummary } from '../../telemetry/api.ts';
import { checkResult, successPrecondition, type CheckFile, type EvaluateFile, type JudgeEntry, type PlayEntry } from './files.ts';
import { appendCoverage, judgeVerdict, type JudgeVerdict } from './results.ts';
import { abs, runRel } from './run.ts';
import { MEMORABLE_MOMENT, type Moment, type Reference } from './setup.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;
/** Grace time of each agent job kill when a signal stops `ogw loop evaluate`: the job supervisor kills it 5000 ms after SIGTERM. */
const SIGNAL_KILL_GRACE_MS = 2000;

/** Dependencies tests replace: the A/B coin, the poll interval, the clock, and the signal handling. */
export const evaluateDeps = {
  /** Returns a number in [0, 1); below 0.5 puts this commit's instance in `A`. */
  random: Math.random,
  pollMs: 5000,
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
  platforms: string[];
  settings: Pick<HarnessSettings, 'maxConcurrentInstances' | 'instanceWaitTimeoutMs' | 'playInstances' | 'backgroundRetryLimit' | 'loopStop'>;
  db: 'postgresql' | undefined;
  /** True when `ogw loop input` asked for the judge moment `memorable_moment` in this run. */
  memorableMoment: boolean;
  /** Folder of the save fixtures taken from the work branch HEAD (`fixturesAtHead`). */
  fixtureDir?: string;
}

/** An instance to start. A start that fails for another reason than a save fixture step ends `ogw loop evaluate`. */
interface Spec {
  commit: string;
  platform?: string;
  fixture?: string;
}

interface PlaySlot {
  role: 'play';
  spec: Spec;
  platform: string;
  moment: Moment | null;
  /** Collects `ogw measure` raw data before stopping (the `playInstances` instances). */
  measure: boolean;
  attempts: number;
  instance: InstanceInfo | null;
  job: string | null;
  entry: PlayEntry | null;
}

interface JudgeSlot {
  role: 'judge';
  kind: 'main' | 'success';
  side: 'A' | 'B';
  moments: Moment[];
  omitted: string[];
  attempts: number;
  instances: InstanceInfo[];
  job: string | null;
  entry: JudgeEntry | null;
}

type Slot = PlaySlot | JudgeSlot;

interface Group {
  size: number;
  slots: Slot[];
  /** Success judges wait for the step 4 judge and start only when the rest of `success` holds. */
  gate: 'none' | 'success';
}

interface State {
  ctx: Context;
  plan: EvaluatePlan;
  queue: Group[];
  /** Every slot in plan order. */
  all: Slot[];
  active: Slot[];
  /** Every instance started and not stopped yet. */
  instances: Map<string, InstanceInfo>;
  /** Ids of the instances whose `startInstance` reserved a slot and has not returned yet. */
  starting: Set<string>;
  jobs: Set<string>;
  measureFiles: string[];
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

function fixturePath(plan: EvaluatePlan, moment: Moment): string {
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

/** Instances of one judge: this commit and the baseline, then a pair per judge moment, within `maxConcurrentInstances`. */
function judgeSlot(plan: EvaluatePlan, kind: 'main' | 'success'): { slot: JudgeSlot; size: number } {
  const perGame = plan.baseline === null ? 1 : 2;
  const max = plan.settings.maxConcurrentInstances;
  const included: Moment[] = [];
  const omitted: string[] = [];
  for (const moment of plan.moments) {
    if (max === null || (included.length + 2) * perGame <= max) included.push(moment);
    else omitted.push(moment.name);
  }
  const side = plan.baseline === null || evaluateDeps.random() < 0.5 ? 'A' : 'B';
  const slot: JudgeSlot = { role: 'judge', kind, side, moments: included, omitted, attempts: 0, instances: [], job: null, entry: null };
  return { slot, size: (included.length + 1) * perGame };
}

function playSlot(spec: Spec, platform: string, moment: Moment | null, measure: boolean): PlaySlot {
  return { role: 'play', spec, platform, moment, measure, attempts: 0, instance: null, job: null, entry: null };
}

export function planGroups(plan: EvaluatePlan): Group[] {
  const groups: Group[] = [];
  const main = judgeSlot(plan, 'main');
  groups.push({ size: main.size, slots: [main.slot], gate: 'none' });
  const plays: Slot[] = [];
  for (let k = 0; k < plan.settings.playInstances; k++) {
    const platform = plan.platforms[k % plan.platforms.length] as string;
    plays.push(playSlot({ commit: plan.commit, platform }, platform, null, true));
  }
  groups.push({ size: plays.length, slots: plays, gate: 'none' });
  const first = plan.platforms[0] as string;
  for (const moment of plan.moments) {
    groups.push({ size: 1, slots: [playSlot({ commit: plan.commit, fixture: fixturePath(plan, moment) }, first, moment, false)], gate: 'none' });
  }
  if (plan.run.kind === 'loop') {
    for (let i = 0; i < plan.settings.loopStop.successJudges; i++) {
      const judge = judgeSlot(plan, 'success');
      groups.push({ size: judge.size, slots: [judge.slot], gate: 'success' });
    }
  }
  return groups;
}

async function inputFile(state: State, role: 'play' | 'judge', input: unknown): Promise<string> {
  const { game, run } = state.plan;
  let ms = evaluateDeps.now();
  if (ms <= state.lastInputMs) ms = state.lastInputMs + 1;
  state.lastInputMs = ms;
  const path = abs(game, runRel(run, `evidence/input-${role}-${String(run.iteration)}-${String(ms)}.json`));
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
  const options: InstanceOptions = { game: state.plan.game.name, commit: spec.commit, client: 'window' };
  if (spec.platform !== undefined) options.platform = spec.platform;
  if (spec.fixture !== undefined) options.fixture = spec.fixture;
  else options.played = true;
  if (state.plan.db) options.db = state.plan.db;
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
  slot.job = await startAgentJob(state.ctx, { role: slot.role, game: state.plan.game.name, input });
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
function sides(plan: EvaluatePlan, slot: JudgeSlot): { A: string; B: string | null } {
  if (plan.baseline === null) return { A: plan.commit, B: null };
  return slot.side === 'A' ? { A: plan.commit, B: plan.baseline } : { A: plan.baseline, B: plan.commit };
}

async function launchJudge(state: State, slot: JudgeSlot): Promise<void> {
  const { plan } = state;
  const { A, B } = sides(plan, slot);
  const a = await start(state, { commit: A });
  const b = B === null ? null : await start(state, { commit: B });
  const fixtures: { moment: Moment; A: string | null; B: string | null }[] = [];
  slot.instances = [a, b].filter((i): i is InstanceInfo => i !== null);
  for (const moment of slot.moments) {
    const fa = await start(state, { commit: A, fixture: fixturePath(plan, moment) });
    const fb = B === null ? null : await start(state, { commit: B, fixture: fixturePath(plan, moment) });
    slot.instances.push(...[fa, fb].filter((i): i is InstanceInfo => i !== null));
    fixtures.push({ moment, A: fa?.id ?? null, B: fb?.id ?? null });
  }
  const input = await inputFile(state, 'judge', {
    A: guide(a),
    B: guide(b),
    fixtures,
    reference: { name: plan.reference.name, presentation: plan.reference.presentation, moments: plan.reference.moments },
  });
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
    const out = abs(state.plan.game, runRel(state.plan.run, `evidence/measure-${String(state.plan.run.iteration)}/${instance.id}.json`));
    const collected = await collectMeasure(state.ctx, state.plan.game.name, instance.id, out).then(
      () => true,
      () => false,
    );
    if (collected) state.measureFiles.push(out);
  }
  await stop(state, instance);
  slot.entry = { result: rel(state, output), instance: instance.id, platform: slot.platform, moment: slot.moment?.name ?? null, status: 'done' };
}

function judgeEntry(state: State, slot: JudgeSlot, output: string | null, verdict: JudgeVerdict | null): JudgeEntry {
  const { A, B } = sides(state.plan, slot);
  return {
    kind: slot.kind,
    result: rel(state, output),
    A,
    B,
    instanceSide: slot.side,
    omittedMoments: slot.omitted,
    vsBaseline: verdict?.vsBaseline ?? null,
    vsReference: verdict?.vsReference ?? 'unknown',
    status: verdict ? 'done' : 'failed',
  };
}

/** Opens or closes the success judges after the step 4 judge; closes them after a success judge that did not pass. */
function updateSuccessGate(state: State, slot: JudgeSlot, entry: JudgeEntry): void {
  if (slot.kind === 'success') {
    if (entry.vsReference !== 'pass') state.successGate = 'closed';
    return;
  }
  const open = successPrecondition(entry, (name) => checkResult(state.plan.check, name));
  state.successGate = open ? 'open' : 'closed';
}

async function stopJudgeInstances(state: State, slot: JudgeSlot): Promise<void> {
  for (const instance of slot.instances) await stop(state, instance);
  slot.instances = [];
}

/** Reads the judge result; null when its tables cannot be read. */
async function readVerdict(state: State, slot: JudgeSlot, output: string): Promise<JudgeVerdict | null> {
  try {
    return judgeVerdict(await readFile(output, 'utf8'), slot.side, state.plan.baseline !== null, slot.moments.map((m) => m.name));
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

/** Polls one running agent. Returns true when it ended. */
async function poll(state: State, slot: Slot): Promise<boolean> {
  const outcome = await agentOutcome(state.ctx, slot.job as string);
  if (outcome.status === 'running') return false;
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
 * Why the step 4 judge did not get `memorable_moment` when it was asked for: `missing` without its `## judge moments`
 * line or its save fixture at the work branch HEAD, `omitted` when that judge did not put it in. undefined otherwise.
 */
function memorableMomentGap(plan: EvaluatePlan, judges: readonly JudgeEntry[]): EvaluateFile['memorableMoment'] {
  if (!plan.memorableMoment) return undefined;
  const fixture = plan.fixtureDir === undefined ? false : exists(join(plan.fixtureDir, `${MEMORABLE_MOMENT}.json`));
  if (!fixture || !plan.moments.some((m) => m.name === MEMORABLE_MOMENT)) return 'missing';
  return judges.find((j) => j.kind === 'main')?.omittedMoments.includes(MEMORABLE_MOMENT) === true ? 'omitted' : undefined;
}

function entries(state: State): { plays: PlayEntry[]; judges: JudgeEntry[] } {
  const plays: PlayEntry[] = [];
  const judges: JudgeEntry[] = [];
  for (const slot of state.all) {
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

async function evaluateWith(ctx: Context, plan: EvaluatePlan): Promise<{ file: EvaluateFile; path: string }> {
  const queue = planGroups(plan);
  const state: State = {
    ctx,
    plan,
    queue,
    all: queue.flatMap((g) => g.slots),
    active: [],
    instances: new Map(),
    starting: new Set(),
    jobs: new Set(),
    measureFiles: [],
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
  try {
    await runSlots(state);
  } catch (error) {
    await abort(state);
    throw error;
  } finally {
    settle();
    off();
  }
  const n = String(plan.run.iteration);
  const measureRel = runRel(plan.run, `measure-${n}.json`);
  const hadMeasure = exists(abs(plan.game, measureRel));
  let measure: string | null = null;
  if (state.measureFiles.length > 0) measure = rel(state, resolve(plan.game.root, (await measureCollected(ctx, plan.game.name, state.measureFiles)).path));
  else await rm(abs(plan.game, measureRel), { force: true });
  const { plays, judges } = entries(state);
  const gap = memorableMomentGap(plan, judges);
  const file: EvaluateFile = { commit: plan.commit, baseline: plan.baseline, plays, judges, measure, ...(gap === undefined ? {} : { memorableMoment: gap }) };
  const path = runRel(plan.run, `evaluate-${n}.json`);
  await writeJsonAtomic(abs(plan.game, path), file);
  const written = [measure, ...plays.map((p) => p.result), ...judges.map((j) => j.result)];
  const paths = written.filter((r): r is string => r !== null && r !== '' && exists(abs(plan.game, r)));
  if (measure === null && hadMeasure) paths.push(measureRel);
  await commitPaths(plan.game.root, [path, ...paths], `loop ${plan.run.name}: evaluate ${n}`, { env: ctx.env });
  return { file, path };
}
