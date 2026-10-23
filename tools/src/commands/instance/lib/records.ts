import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { readJsonIfExists, writeJsonAtomic } from '../../../lib/fsx.ts';
import { commonDir } from '../../../lib/git.ts';
import { withLock } from '../../../lib/lock.ts';
import { hostBootId } from '../../../lib/jobs.ts';
import { harnessRoot } from '../../../lib/paths.ts';
import { isAlive } from '../../../lib/proc.ts';

export type InstanceStatus = 'starting' | 'running' | 'failed' | 'stopping';

/** One match mode row an opponent bot client plays. */
export interface MatchModeRow {
  /** ID name of the `match_mode` row, for example `[duel]`. */
  id: string;
  minPlayers: number;
  maxPartySize: number;
  allowQueue: boolean;
  allowRoom: boolean;
}

export interface FixtureStep {
  kind: string;
  command: string;
  args: string[];
  until: unknown;
  timeoutMs: number;
}

/** Everything the supervisor needs, decided by `instance start`. */
export interface InstancePlan {
  engine: string;
  enginePath: string;
  /** `rendering_method` of the instance platform. */
  renderingMethod: string;
  client: 'window' | 'headless' | 'none';
  /** With client `none`: the runner opens the automation channel `main` for a client it does not start. */
  external?: boolean;
  /**
   * The client `main` is played by a play or judge agent (window, no save fixture): it gets no dev account, goes
   * through `AuthCore.boot_login` (terms popup), and the start does not wait for its `Done`.
   */
  played?: boolean;
  db: 'sqlite' | 'postgresql';
  /** `postgres:<tag>@<digest>` when `db` is `postgresql`. */
  postgresImage: string | null;
  realtime: boolean;
  social: boolean;
  /** `server/dev/populate.ts` exists. */
  populate: boolean;
  /** One entry per opponent bot client, in `n` order (`opponent_1` first). */
  opponents: MatchModeRow[];
  fixture: FixtureStep[] | null;
  /** `QACore.commandTimeoutMs` of the merged core settings. */
  commandTimeoutMs: number;
  /** `QACore.videoMaxMs` of the merged core settings; null when it has none. */
  videoMaxMs?: number | null;
  /** `QACore.feedbackWindowMs` of the merged core settings; null when it has none. */
  feedbackWindowMs?: number | null;
  /** Game settings `targetFps` (or its default); `ogw input` takes 1000 / it as the client frame time. */
  targetFps?: number;
  /** The client `main` writes its frames and sound to `file` with the engine's movie maker (`ogw video`). */
  movie?: { file: string; resolution: [number, number] };
}

/** Dev account of the client `main` when no play or judge agent plays it. */
export const MAIN_DEV_ACCOUNT = 'main';

/** A client of an instance plan: its name, the dev account it logs in with (empty: `AuthCore.boot_login`), and headless or not. */
export interface PlannedClient {
  name: 'main' | 'social' | `opponent_${number}`;
  account: string;
  headless: boolean;
}

/** Name of the opponent bot client of the `index`-th (0-based) entry of `InstancePlan.opponents`. */
export function opponentName(index: number): `opponent_${number}` {
  return `opponent_${String(index + 1)}` as `opponent_${number}`;
}

/** Clients of an instance plan in this order: `main` (absent with client `none`), `social`, `opponent_<n>` by `n`. */
export function plannedClients(plan: InstancePlan): PlannedClient[] {
  const clients: PlannedClient[] = [];
  if (plan.client !== 'none') clients.push({ name: 'main', account: plan.played === true ? '' : MAIN_DEV_ACCOUNT, headless: plan.client === 'headless' });
  if (plan.social) clients.push({ name: 'social', account: 'social', headless: true });
  plan.opponents.forEach((_, i) => {
    clients.push({ name: opponentName(i), account: opponentName(i), headless: true });
  });
  return clients;
}

export interface InstanceRecord {
  id: string;
  game: string;
  root: string;
  mainRoot: string;
  /** Worktree made for `--commit`; removed when the instance stops. */
  worktree: string | null;
  commit: string;
  platform: string;
  status: InstanceStatus;
  error: string | null;
  /** Why the start failed: a save fixture step failed, or anything else. */
  failure: 'fixture' | 'start' | null;
  startedAt: number;
  /** pid of the `instance start` process while the instance is starting. */
  ownerPid: number;
  /** The `ogw agent` job whose agent started the instance; null when no agent did. The tool stops it when that job ends. */
  agentJob?: string | null;
  supervisorPid: number | null;
  /** `hostBootId()` when the record was made; its pids mean nothing in another boot of the host. */
  bootId?: string | null;
  serverUrl: string;
  adminSecret: string;
  /** Control channel of the supervisor and its full control token; the play access file has the restricted token. */
  control: { port: number; token: string } | null;
  /** pids of the server process and clients, by name (`server`, `main`, `opponent_1`, `social`). */
  pids: Record<string, number>;
  /** Processes that ended while the instance ran, with their exit code. */
  exited: Record<string, number | null>;
  container: string | null;
  /** null while `instance start` prepares the checkout. */
  plan: InstancePlan | null;
  /** Launch values of the client the runner did not start (`InstancePlan.external`); absent otherwise. */
  external?: ExternalClient | null;
}

/** What a client the runner does not start (device, headless browser) needs to join the instance. */
export interface ExternalClient {
  /** Loopback port of the automation channel WebSocket server of the client `main`. */
  automationPort: number;
  automationToken: string;
  /** The dev access value the runner gave the instance server. */
  devAccess: string;
  /** Dev account (`OGW_DEV_ACCOUNT`) the client logs in with. */
  devAccount: string;
}

/**
 * Folder of the instance records (full control token, admin secret, dev access) and the instance folders (DB, logs).
 * The play and judge sandbox blocks it (ogw.md `## agent`).
 */
export async function instancesDir(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const override = env.OGW_INSTANCES_DIR;
  if (override) return override;
  return join(await commonDir(harnessRoot(env), { env }), 'ogw-instances');
}

/** Folder of the play access files: read by the play commands, which a play or judge agent runs through its broker. */
export async function playAccessDir(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const override = env.OGW_PLAY_ACCESS_DIR;
  if (override) return override;
  return join(await commonDir(harnessRoot(env), { env }), 'ogw-instance-play-access');
}

/**
 * What the play commands (`input`, `capture`, `log`, `telemetry`, `step-mode`, `step`) need of a running instance:
 * the control channel with the restricted play token, which the supervisor takes only for input, capture,
 * observation and step mode requests (`playAccessRefusal`).
 */
export interface PlayAccess {
  id: string;
  port: number;
  token: string;
  /** Clients of the instance, as `InstanceInfo.clients`. */
  clients: PlannedClient['name'][];
  commandTimeoutMs: number;
  videoMaxMs: number | null;
  feedbackWindowMs: number | null;
  /** `InstancePlan.targetFps`; null when the plan has none. */
  targetFps: number | null;
}

async function playAccessPath(id: string, env: NodeJS.ProcessEnv): Promise<string> {
  checkInstanceId(id);
  return join(await playAccessDir(env), `${id}.json`);
}

export async function writePlayAccess(access: PlayAccess, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await writeJsonAtomic(await playAccessPath(access.id, env), access);
}

/** The play access of a running instance; fails when the instance is not running. */
export async function readPlayAccess(id: string, env: NodeJS.ProcessEnv = process.env): Promise<PlayAccess> {
  const access = await readJsonIfExists<PlayAccess>(await playAccessPath(id, env));
  if (!access) throw new OgwError(`instance ${id} is not running`);
  return access;
}

export async function deletePlayAccess(id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await rm(await playAccessPath(id, env), { force: true });
}

const ID = /^[a-z0-9_-]+$/;

export function checkInstanceId(id: string): void {
  if (!ID.test(id)) throw new OgwError(`invalid instance id: ${id}`);
}

export async function recordPath(id: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  checkInstanceId(id);
  return join(await instancesDir(env), `${id}.json`);
}

/** Folder of the files of one instance: logs and the SQLite DB. */
export async function instanceFolder(id: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  checkInstanceId(id);
  return join(await instancesDir(env), id);
}

export async function slotLock(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return join(await instancesDir(env), 'slots.lock');
}

export async function readRecord(id: string, env: NodeJS.ProcessEnv = process.env): Promise<InstanceRecord> {
  const record = await readJsonIfExists<InstanceRecord>(await recordPath(id, env));
  if (!record) throw new OgwError(`instance not found: ${id}`);
  return record;
}

export async function writeRecord(record: InstanceRecord, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await writeJsonAtomic(await recordPath(record.id, env), record);
}

export async function updateRecord(
  id: string,
  change: (record: InstanceRecord) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InstanceRecord> {
  return withLock(join(await instancesDir(env), `${id}.lock`), async () => {
    const record = await readRecord(id, env);
    change(record);
    await writeRecord(record, env);
    return record;
  });
}

/**
 * Removes the record under its lock, so an `updateRecord` in flight (a start of the instance, its supervisor) cannot
 * write it back; their next `updateRecord` fails and ends that start.
 */
export async function deleteRecord(id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await deletePlayAccess(id, env);
  const path = await recordPath(id, env);
  await withLock(join(await instancesDir(env), `${id}.lock`), () => rm(path, { force: true }));
  await rm(await instanceFolder(id, env), { recursive: true, force: true });
}

export async function listRecords(env: NodeJS.ProcessEnv = process.env): Promise<InstanceRecord[]> {
  const dir = await instancesDir(env);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const records: InstanceRecord[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const record = await readJsonIfExists<InstanceRecord>(join(dir, name)).catch(() => null);
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

/** True when the record was made in an earlier boot of the host: its pids may now belong to other processes. */
export function fromEarlierBoot(record: InstanceRecord, bootId: string | null = hostBootId()): boolean {
  return typeof record.bootId === 'string' && bootId !== null && record.bootId !== bootId;
}

/**
 * True when the instance takes a slot: it is starting and its `instance start` process lives,
 * or its supervisor lives. An instance of an earlier boot of the host takes none.
 */
export function takesSlot(record: InstanceRecord): boolean {
  if (record.status === 'failed' || fromEarlierBoot(record)) return false;
  if (record.supervisorPid !== null && isAlive(record.supervisorPid)) return true;
  return record.status === 'starting' && isAlive(record.ownerPid);
}
