import { open, readFile, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import type { GameRepo } from '../../lib/game.ts';
import { commonDir, head, revParse, worktreeAdd, worktreeRemove } from '../../lib/git.ts';
import { exists, isNotFound, readJson, writeJsonAtomic } from '../../lib/fsx.ts';
import { newId } from '../../lib/ids.ts';
import { LIMITS } from '../../lib/limits.ts';
import { withLock } from '../../lib/lock.ts';
import { span, spanContext, takeWaits, taking } from '../../lib/spans.ts';
import { agentContext } from '../../lib/agentctx.ts';
import { hostBootId, JobNotFound, readJob } from '../../lib/jobs.ts';
import { isAlive, killTree } from '../../lib/proc.ts';
import { gameSettingsPath, loadGameSettings, withGameSettingsLock } from '../../lib/settings.ts';
import { controlCall, type ClientRef } from './automation.ts';
import { randomBaseText } from './lib/launch.ts';
import { concurrencyLimit, generateIfNeeded, importIfNeeded, instancePlatform, makePlan } from './lib/prepare.ts';
import { removePostgres } from './lib/postgres.ts';
import {
  checkInstanceId,
  deleteRecord,
  fromEarlierBoot,
  instanceFolder,
  InstanceNotFound,
  listRecords,
  plannedClients,
  readRecord,
  recordPath,
  slotLock,
  takesSlot,
  updateRecord,
  writeRecord,
  type ExternalClient,
  type InstanceRecord,
} from './lib/records.ts';

export type { ExternalClient } from './lib/records.ts';
import { runHarnessSettings } from '../loop/lib/harness-pin.ts';
import { launchSupervisor } from './lib/spawn.ts';
import { FixtureError } from './lib/steps.ts';
import { START_LIMIT_MS } from './lib/supervisor.ts';

export interface InstanceOptions {
  game: string;
  /** Run from a worktree `worktrees/<game>/instance-<id>/` of this commit. */
  commit?: string;
  /** Platform the client imitates. Default: the first of game settings `buildPlatforms`. */
  platform?: string;
  /** Save fixture file whose steps run before the instance is handed back. */
  fixture?: string;
  db?: 'postgresql';
  /**
   * `window`: the client draws (play, judge, UI quality, instance measure). `headless`: headless run (bot playtest,
   * row simulation). `none`: no client; bot clients still start (build-time check).
   */
  client?: 'window' | 'headless' | 'none';
  /**
   * With client `none`: open the automation channel `main` (port, token) for a client the runner does not
   * start, such as the device or headless browser client of the build-time checks. `InstanceInfo.external`
   * gives its launch values. Bot clients that need the client `main` wait until it connects.
   */
  externalClient?: boolean;
  /**
   * The client `main` is played by a play or judge agent: it gets no dev account and goes through
   * `AuthCore.boot_login`, and the start does not wait for its `Done`. Only with client `window` and no `fixture`.
   * Otherwise the client `main` (the outside one of `externalClient` too) logs in with dev account `main`.
   */
  played?: boolean;
  /** Record the client `main` with the engine's movie maker into `file` (`ogw video`), in a window of game settings `baseResolution`, at `MOVIE_FPS`. */
  movie?: { file: string };
  /**
   * Folder to run instead of `games/<game>/`, for example the benchmark game unpacked from a core release.
   * Not with `commit`. It need not be a git repo.
   */
  root?: string;
  /** Core version to run with instead of game settings `coreVersion`; only with `root`, whose `settings.json` it rewrites. */
  coreVersion?: string;
  /** Start without the `maxConcurrentInstances` check and wait (`ogw instance measure`). */
  ignoreConcurrencyLimit?: boolean;
  /** `--input-latency`: the supervisor delays each input command to the client `main` by this many ms. */
  inputLatencyMs?: number;
  /**
   * `--random-base` (an int64): every client gets it as the launch value `OGW_RANDOM_BASE`, and the server process is
   * `start_local_server` of `testing` with it (ogw.md `## runner`). Absent: the secure random of the server.
   */
  randomBase?: bigint;
  /** The id of the instance, made with `newId` by a caller that names the instance before it starts (a judge input); a new id otherwise. */
  id?: string;
}

export interface InstanceInfo {
  id: string;
  game: string;
  /** Checkout the instance runs from: the game repo, its worktree, or `worktrees/<game>/instance-<id>/`. */
  root: string;
  commit: string;
  platform: string;
  /** Base URL of the server process, for example `http://127.0.0.1:41234`. */
  serverUrl: string;
  /** Secret of the admin operator `ogw` the runner made. Never printed by commands other than `instance start`. */
  adminSecret: string;
  startedAt: number;
  /** The instance was started with a save fixture (`--fixture`). */
  fixture: boolean;
  /** Clients of the instance in this order: `main` (absent with client `none`), `social`, `opponent_<n>` by `n`. */
  clients: ClientRef[];
  /** Processes (`server`, client names) that ended while the instance ran, with their exit code. */
  exited: Record<string, number | null>;
  /** File the server process writes its log lines to. */
  serverLog: string;
  /** Launch values of the client the runner did not start (`externalClient`), or null. */
  external: ExternalClient | null;
}

/** Calls of `startInstance` into its caller. */
export interface StartHooks {
  /**
   * Called with the instance id once its record took a slot, before the instance boots. `stopInstance` with this id
   * stops the instance while it starts, and the pending `startInstance` then fails.
   */
  onReserved?: (id: string) => void;
  /**
   * Once aborted, `startInstance` stops waiting for a slot without taking one, or stops the instance it reserved
   * at its next step, and fails.
   */
  signal?: AbortSignal;
  /**
   * Called with the instance id when the start failed after the id was reserved, before the instance is stopped and
   * its folder removed: the caller can still read the instance folder and record. A throw is added to the start
   * failure, and the instance is still stopped.
   */
  beforeFailedStop?: (id: string) => Promise<void>;
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new OgwError('instance start was stopped');
}

const SLOT_POLL_MS = 1000;

/** null for a job whose record is gone; any other read error is not "no job". */
function jobGone(error: unknown): null {
  if (error instanceof JobNotFound) return null;
  throw error;
}

async function infoOf(record: InstanceRecord, env: NodeJS.ProcessEnv): Promise<InstanceInfo> {
  const plan = record.plan;
  const clients: ClientRef[] = plan ? plannedClients(plan).map((c) => c.name) : [];
  return {
    id: record.id,
    game: record.game,
    root: record.root,
    commit: record.commit,
    platform: record.platform,
    serverUrl: record.serverUrl,
    adminSecret: record.adminSecret,
    startedAt: record.startedAt,
    fixture: (plan?.fixture ?? null) !== null,
    clients,
    exited: record.exited,
    serverLog: join(await instanceFolder(record.id, env), 'server.log'),
    external: record.external ?? null,
  };
}

/** Writes the record of a new instance once fewer than `max` instances take a slot. */
async function reserveSlot(ctx: Context, record: InstanceRecord, max: number, waitMs: number, signal?: AbortSignal): Promise<void> {
  const lock = await slotLock(ctx.env);
  // a reservation that does not take its slot at its first try is a wait on the instance slots (ogw.md `## time`)
  await taking(join(dirname(lock), 'slots'), () => takeSlot(ctx, record, { lock, max, waitMs }, signal));
}

async function takeSlot(ctx: Context, record: InstanceRecord, limits: { lock: string; max: number; waitMs: number }, signal?: AbortSignal): Promise<void> {
  const { lock, max, waitMs } = limits;
  const deadline = Date.now() + waitMs;
  for (;;) {
    checkAborted(signal);
    const taken = await withLock(lock, async () => {
      if (signal?.aborted === true) return false;
      const busy = (await listRecords(ctx.env)).filter(takesSlot).length;
      if (busy >= max) return false;
      // an agent that ended while this start waited would leave the instance to nobody (instance.md `## start and stop`)
      // the job stays `running` while it finishes after its agent CLI ended, so `cliEnded` counts as ended too
      const agent = record.agentJob == null ? null : await readJob(record.agentJob, ctx.env).catch(jobGone);
      if (record.agentJob != null && (agent?.status !== 'running' || agent.meta.cliEnded === true)) {
        throw new OgwError(`the ogw agent job ${record.agentJob} that started this instance has ended`, 1, { reason: 'start' } satisfies StartFailure);
      }
      await writeRecord(record, ctx.env);
      return true;
    });
    if (taken) return;
    checkAborted(signal);
    if (Date.now() >= deadline) {
      throw new OgwError(
        `no instance slot within instanceWaitTimeoutMs (${String(waitMs)} ms): ${String(max)} instances are running`,
        1,
        { reason: 'wait-timeout' } satisfies StartFailure,
      );
    }
    takeWaits();
    await sleep(Math.min(SLOT_POLL_MS, Math.max(0, deadline - Date.now())), undefined, { signal }).catch((error: unknown) => {
      // the abort of `signal` ends the wait: the start fails as stopped
      checkAborted(signal);
      throw error;
    });
  }
}

/**
 * The checkout of the instance. A `commit` worktree is in the record before `git worktree add` makes it, so a stop
 * during the add removes it; `onWorktree` gets its path first, so the start removes it when the stop came earlier.
 */
async function checkoutOf(
  ctx: Context,
  game: GameRepo,
  id: string,
  commit: string | undefined,
  onWorktree: (path: string) => void,
): Promise<GameRepo> {
  if (commit === undefined) return game;
  const sha = await revParse(game.root, commit, { env: ctx.env });
  if (!sha) throw new OgwError(`commit not found in ${game.name}: ${commit}`);
  const worktree = join((await ctx.workspace()).worktrees, game.name, `instance-${id}`);
  await updateRecord(id, (r) => {
    r.worktree = worktree;
  }, ctx.env);
  onWorktree(worktree);
  await worktreeAdd(game.root, worktree, sha, undefined, { env: ctx.env });
  await updateRecord(id, (r) => {
    r.root = worktree;
  }, ctx.env);
  return { ...game, root: worktree, inWorktree: true };
}

/**
 * The `ogw agent` job whose agent starts this instance: the agent of this process, or, for a `--background` job, the
 * agent its job record names. The job record keeps it after the agent ended, which `agentContext` does not see.
 */
async function startingAgent(ctx: Context): Promise<string | null> {
  const agent = (await agentContext(ctx.env))?.job.id ?? null;
  if (agent !== null || ctx.jobId === null) return agent;
  return (await readJob(ctx.jobId, ctx.env).catch(jobGone))?.agentJob ?? null;
}

/** Game settings `baseResolution` as `[width, height]`. */
function baseResolution(gameSettings: Record<string, unknown>): [number, number] {
  const value = gameSettings.baseResolution;
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => Number.isInteger(n) && (n as number) > 0)) {
    throw new OgwError('game settings has no baseResolution');
  }
  return [value[0] as number, value[1] as number];
}

function newRecord(id: string, game: GameRepo, agentJob: string | null): InstanceRecord {
  return {
    id,
    game: game.name,
    root: game.root,
    mainRoot: game.mainRoot,
    worktree: null,
    commit: '',
    platform: '',
    status: 'starting',
    error: null,
    failure: null,
    startedAt: Date.now(),
    ownerPid: process.pid,
    agentJob,
    supervisorPid: null,
    bootId: hostBootId(),
    serverUrl: '',
    adminSecret: '',
    control: null,
    pids: {},
    exited: {},
    container: null,
    plan: null,
  };
}

/** Waits until the supervisor recorded `running` or `failed`. */
async function waitStarted(ctx: Context, id: string): Promise<InstanceRecord> {
  const deadline = Date.now() + START_LIMIT_MS + LIMITS.shortMs;
  for (;;) {
    const record = await readRecord(id, ctx.env);
    if (record.status === 'running') return record;
    if (record.status === 'failed') {
      throw new OgwError(`instance start failed: ${record.error ?? 'unknown error'}`, 1, { reason: record.failure ?? 'start' } satisfies StartFailure);
    }
    const supervisorGone = record.supervisorPid !== null && !isAlive(record.supervisorPid);
    if (supervisorGone || Date.now() >= deadline) {
      throw new OgwError(supervisorGone ? 'instance start failed: the supervisor ended' : 'instance start timed out');
    }
    await sleep(200);
  }
}

/**
 * Runner: starts an instance and returns it once every client reached `boot_stage` `Done`; a client `main` that a
 * play or judge agent plays (`played`) only needs its automation channel connected.
 */
export async function startInstance(ctx: Context, options: InstanceOptions, hooks: StartHooks = {}): Promise<InstanceInfo> {
  try {
    return await span('instance start', () => start(ctx, options, hooks));
  } catch (error) {
    throw asStartFailure(error);
  }
}

/** The game repo, or the folder of `options.root` (with `options.coreVersion` written to its settings). */
async function gameOf(ctx: Context, options: InstanceOptions): Promise<GameRepo> {
  if (options.root === undefined) {
    if (options.coreVersion !== undefined) throw new OgwError('coreVersion goes with root');
    return ctx.game(options.game);
  }
  if (options.commit !== undefined) throw new OgwError('commit does not go with root');
  const root = resolve(ctx.cwd, options.root);
  if (options.coreVersion !== undefined) {
    const path = gameSettingsPath(root);
    const coreVersion = options.coreVersion;
    await withGameSettingsLock(root, ctx.env, async () => {
      await writeJsonAtomic(path, { ...(await readJson<Record<string, unknown>>(path)), coreVersion });
    });
  }
  const git = exists(join(root, '.git'));
  return { name: options.game, root, mainRoot: root, commonDir: git ? await commonDir(root, { env: ctx.env }) : join(root, '.git'), inWorktree: false };
}

function checkOptions(options: InstanceOptions): void {
  if (options.externalClient === true && options.client !== 'none') throw new OgwError('externalClient goes with client none');
  if (options.externalClient === true && options.fixture !== undefined) throw new OgwError('externalClient does not go with fixture');
  if (options.played === true && (options.client ?? 'window') !== 'window') throw new OgwError('played goes with client window');
  if (options.played === true && options.fixture !== undefined) throw new OgwError('played does not go with fixture');
}

async function start(ctx: Context, options: InstanceOptions, hooks: StartHooks): Promise<InstanceInfo> {
  checkOptions(options);
  const randomBase = options.randomBase === undefined ? undefined : randomBaseText(options.randomBase);
  const game = await gameOf(ctx, options);
  // an instance of a game repo is started with the run settings of its open loop run (ogw.md `## loop start`)
  const settings = options.root === undefined ? await runHarnessSettings(ctx, game) : await ctx.settings();
  const max = options.ignoreConcurrencyLimit === true ? Number.POSITIVE_INFINITY : concurrencyLimit(settings);
  const id = options.id ?? newId();
  if (options.id !== undefined) {
    checkInstanceId(id);
    if (exists(await recordPath(id, ctx.env))) throw new OgwError(`instance ${id} exists`);
  }
  const { signal } = hooks;
  await reserveSlot(ctx, newRecord(id, game, await startingAgent(ctx)), max, settings.instanceWaitTimeoutMs, signal);
  hooks.onReserved?.(id);
  const made: { worktree: string | null } = { worktree: null };
  // the removal of the import cache entries beyond those kept, beside the boot: its failure, or null once it ended
  let evicted: Promise<Error | null> = Promise.resolve(null);
  try {
    checkAborted(signal);
    const checkout = await span('worktree', () => checkoutOf(ctx, game, id, options.commit, (path) => {
      made.worktree = path;
    }));
    checkAborted(signal);
    const gameSettings = await loadGameSettings(checkout.root);
    const platform = instancePlatform(gameSettings, options.platform);
    // its steps `generate` and `data` (ogw.md `## time`)
    await generateIfNeeded(ctx, checkout, made.worktree !== null || options.root !== undefined);
    checkAborted(signal);
    const plan = await span('plan', () => makePlan(ctx, {
      checkout,
      settings,
      gameSettings,
      platform,
      client: options.client ?? 'window',
      db: options.db,
      fixture: options.fixture === undefined ? undefined : resolve(ctx.cwd, options.fixture),
    }));
    // a fresh `--commit` checkout gets the import of another checkout with the same files (ogw.md `## runner`)
    const imported = await span('import', () => importIfNeeded(ctx, plan, checkout.root, made.worktree === null ? null : { commonDir: game.commonDir, keep: max }));
    const evict = imported.evict;
    if (evict !== null) evicted = span('import evict', evict).then(() => null, (error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    checkAborted(signal);
    const commit = exists(join(checkout.root, '.git')) ? await head(checkout.root, { env: ctx.env }) : '';
    await updateRecord(id, (r) => {
      r.commit = commit;
      r.platform = platform;
      r.plan = {
        ...plan,
        ...(options.externalClient === true ? { external: true } : {}),
        ...(options.played === true ? { played: true } : {}),
        ...(options.movie === undefined ? {} : { movie: { file: options.movie.file, resolution: baseResolution(gameSettings) } }),
        ...(options.inputLatencyMs === undefined || options.inputLatencyMs <= 0 ? {} : { inputLatencyMs: options.inputLatencyMs }),
        ...(randomBase === undefined ? {} : { randomBase }),
      };
    }, ctx.env);
    checkAborted(signal);
    // the supervisor writes the spans of its boot in this span (ogw.md `## time`)
    const booted = await span('boot', async () => {
      const spans = spanContext();
      if (spans !== null) {
        await updateRecord(id, (r) => {
          r.spans = spans;
        }, ctx.env);
      }
      await launchSupervisor(id, ctx.env);
      return waitStarted(ctx, id);
    });
    const info = await infoOf(booted, ctx.env);
    const evictFailure = await evicted;
    if (evictFailure !== null) throw evictFailure;
    return info;
  } catch (error) {
    const { failures, notStopped } = await cleanUpFailedStart(ctx, game, id, made.worktree, hooks);
    // the start ends only once the removal ended, and a removal that failed fails it too
    const evictFailure = await evicted;
    if (evictFailure !== null && evictFailure !== error) failures.push(`removing the import cache entries beyond those kept: ${evictFailure.message}`);
    throw withCleanupFailures(error, failures, notStopped);
  }
}

/**
 * Stops the instance of a failed start and removes its worktree, each step even when another failed; the messages of
 * the steps that failed, and the instance with the failure of its stop when the stop failed. An instance a stop already
 * removed is no failure: a stop of the id (`onReserved`) that came before the worktree add left the record gone and the
 * worktree here.
 */
async function cleanUpFailedStart(ctx: Context, game: GameRepo, id: string, worktree: string | null, hooks: StartHooks): Promise<{ failures: string[]; notStopped: NotStopped | null }> {
  const failures: string[] = [];
  const step = async (what: string, work: () => Promise<void>): Promise<string | null> => {
    try {
      await work();
      return null;
    } catch (error) {
      if (error instanceof InstanceNotFound) return null;
      const message = (error as Error).message;
      failures.push(`${what}: ${message}`);
      return message;
    }
  };
  const keep = hooks.beforeFailedStop;
  if (keep !== undefined) await step('keeping the instance files', () => keep(id));
  const stopFailure = await step(`stopping instance ${id}`, () => stopInstance(ctx, id));
  // the stop removes the worktree its record names; one it did not remove is removed here
  if (worktree !== null && exists(worktree)) await step(`removing the worktree ${worktree}`, () => worktreeRemove(game.mainRoot, worktree, { env: ctx.env }));
  return { failures, notStopped: stopFailure === null ? null : { instance: id, error: stopFailure } };
}

/**
 * The failure of a start whose cleanup failed too: the start failure with the cleanup failures added to its message,
 * its exit code and `data` kept, and in `data` the instance the cleanup could not stop (`notStopped`); the start
 * failure itself when the cleanup did not fail.
 */
function withCleanupFailures(error: unknown, failures: readonly string[], notStopped: NotStopped | null): unknown {
  if (failures.length === 0) return error;
  const start = asStartFailure(error);
  const data = notStopped === null ? start.data : { ...(start.data as StartFailure), notStopped } satisfies StartFailure;
  return new OgwError(`${start.message}\nthe cleanup after the failed start failed: ${failures.join('; ')}`, start.exitCode, data);
}

/** The instance of a failed start that its cleanup could not stop, and the failure of that stop. */
export interface NotStopped {
  instance: string;
  error: string;
}

/**
 * `data` of the `OgwError` `startInstance` throws: `wait-timeout` when no slot came within
 * `instanceWaitTimeoutMs`, `fixture` when a save fixture step failed, `start` for every other failure. `notStopped`
 * is there when the cleanup after the failed start could not stop its instance, which may then still run.
 */
export interface StartFailure {
  reason: 'wait-timeout' | 'fixture' | 'start';
  notStopped?: NotStopped;
}

function asStartFailure(error: unknown): OgwError {
  if (error instanceof OgwError && (error.data as Partial<StartFailure> | undefined)?.reason !== undefined) return error;
  if (error instanceof FixtureError) return new OgwError(error.message, 1, { reason: 'fixture' } satisfies StartFailure);
  const message = error instanceof Error ? error.message : String(error);
  return new OgwError(message, error instanceof OgwError ? error.exitCode : 1, { reason: 'start' } satisfies StartFailure);
}

/**
 * Stops the instance, its processes, its DB container, and removes its `--commit` worktree.
 * The pids of an instance of an earlier boot of the host are not killed: they may now belong to other processes.
 */
export async function stopInstance(ctx: Context, id: string): Promise<void> {
  await span('instance stop', () => stop(ctx, id));
}

async function stop(ctx: Context, id: string): Promise<void> {
  const record = await readRecord(id, ctx.env);
  await updateRecord(id, (r) => {
    if (r.status !== 'failed') r.status = 'stopping';
  }, ctx.env);
  const earlierBoot = fromEarlierBoot(record);
  const supervisorAlive = !earlierBoot && record.supervisorPid !== null && isAlive(record.supervisorPid);
  let stopped = false;
  if (record.control && supervisorAlive) {
    // a supervisor that does not stop the instance is killed with its processes
    stopped = await controlCall(record.control.port, record.control.token, '/stop', {}, LIMITS.shortMs * 2).then(
      () => true,
      (error: unknown) => {
        ctx.log(`instance ${id}: the supervisor did not stop it (${(error as Error).message}); its processes are killed`);
        return false;
      },
    );
  }
  if (!stopped) {
    if (!earlierBoot) {
      for (const pid of Object.values(record.pids)) killTree(pid, 'SIGKILL');
      if (record.supervisorPid !== null && record.supervisorPid !== process.pid) killTree(record.supervisorPid, 'SIGKILL');
    }
    if (record.container !== null || record.plan?.db === 'postgresql') await removePostgres(id, ctx.env);
  }
  if (record.worktree !== null) await worktreeRemove(record.mainRoot, record.worktree, { env: ctx.env });
  await deleteRecord(id, ctx.env);
}

/**
 * Stops every instance that the agent of `ogw agent` job `agentJob` started, whatever its status. Call it after the
 * agent's CLI ended (`cliEnded`): the list is read under the slot lock, so a start that wrote its record before is in it,
 * and a start that takes the lock after sees `cliEnded` and is refused (`reserveSlot`).
 */
export async function stopInstancesOfAgent(ctx: Context, agentJob: string): Promise<string[]> {
  const ids = await withLock(await slotLock(ctx.env), async () => (await listRecords(ctx.env)).filter((r) => r.agentJob === agentJob).map((r) => r.id));
  // every instance is stopped even when the stop of another failed; one a stop removed meanwhile is no failure
  const failures: string[] = [];
  for (const id of ids) {
    await stopInstance(ctx, id).catch((error: unknown) => {
      if (!(error instanceof InstanceNotFound)) failures.push(`instance ${id}: ${(error as Error).message}`);
    });
  }
  if (failures.length > 0) throw new OgwError(`the instances of agent job ${agentJob} were not all stopped: ${failures.join('; ')}`);
  return ids;
}

/** Instances that are running, optionally of one game. */
export async function listInstances(ctx: Context, filter: { game?: string } = {}): Promise<InstanceInfo[]> {
  const records = (await listRecords(ctx.env)).filter(
    (r) => r.status === 'running' && takesSlot(r) && (filter.game === undefined || r.game === filter.game),
  );
  return Promise.all(records.map((r) => infoOf(r, ctx.env)));
}

/** Instances of a game that are not `failed`: `starting`, `running` and `stopping` ones, oldest first. */
export async function unfailedInstances(ctx: Context, game: string): Promise<{ id: string; status: string; startedAt: number }[]> {
  return (await listRecords(ctx.env)).filter((r) => r.game === game && r.status !== 'failed').map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt }));
}

/** A running instance; fails when it is not running. */
export async function getInstance(ctx: Context, id: string): Promise<InstanceInfo> {
  const record = await readRecord(id, ctx.env);
  if (record.status !== 'running') throw new OgwError(`instance ${id} is not running (${record.status})`);
  return infoOf(record, ctx.env);
}

export interface InstanceProcesses {
  server: boolean;
  clients: { client: ClientRef; alive: boolean }[];
}

function processAlive(record: InstanceRecord, name: string): boolean {
  const pid = record.pids[name];
  return pid !== undefined && !(name in record.exited) && isAlive(pid);
}

/** Whether the server process and each client process (bot clients included) of the instance still run. */
export async function instanceProcesses(ctx: Context, id: string): Promise<InstanceProcesses> {
  const record = await readRecord(id, ctx.env);
  const info = await infoOf(record, ctx.env);
  return {
    server: processAlive(record, 'server'),
    clients: info.clients.map((client) => ({ client, alive: processAlive(record, client) })),
  };
}

/**
 * The server log (one JSON object per line) the server process of the instance wrote so far, from byte `fromByte`
 * (empty when the log is shorter, or when the server has not made the file yet). Other read errors throw: an unread log
 * is not a log without errors.
 */
export async function instanceServerLog(ctx: Context, id: string, fromByte = 0): Promise<string> {
  const info = await infoOf(await readRecord(id, ctx.env), ctx.env);
  const notMadeYet = (error: unknown): string => {
    if (isNotFound(error)) return '';
    throw error;
  };
  if (fromByte <= 0) return readFile(info.serverLog, 'utf8').catch(notMadeYet);
  let file: FileHandle;
  try {
    file = await open(info.serverLog, 'r');
  } catch (error) {
    return notMadeYet(error);
  }
  try {
    const size = (await file.stat()).size;
    if (size <= fromByte) return '';
    const buffer = Buffer.alloc(size - fromByte);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, fromByte);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}
