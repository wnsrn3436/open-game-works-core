import type { ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { OgwError } from '../../../lib/errors.ts';
import { isPlainObject } from '../../../lib/json.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { killTree, run, spawnTracked } from '../../../lib/proc.ts';
import { BotGate, commandNames, oneCommand, opponentLoop, roomCapable, roomWatch, socialLoop, type OpponentBot } from './bots.ts';
import { ClientChannel, type FrameHandler } from './channel.ts';
import {
  clientLaunch,
  freePort,
  launchValueFileContent,
  newLocalSecrets,
  populateLaunch,
  serverLaunch,
  serverSecretValues,
  writeSecretFile,
  type Launch,
  type LaunchValues,
  type LocalSecrets,
  type ServerDb,
} from './launch.ts';
import { removePostgres, startPostgres } from './postgres.ts';
import { playAccessRefusal } from './qa.ts';
import {
  MAIN_DEV_ACCOUNT,
  deletePlayAccess,
  instanceFolder,
  opponentName,
  plannedClients,
  readRecord,
  updateRecord,
  writePlayAccess,
  type InstancePlan,
  type InstanceRecord,
} from './records.ts';
import { FixtureError, getState, runStep, waitBootDone, type Requester } from './steps.ts';

/** Time limit of everything `instance start` does: server, populate, clients, boot, fixture. */
export const START_LIMIT_MS = LIMITS.programMs;
const KILL_GRACE_MS = 5000;

function clientName(body: Record<string, unknown>): string {
  return typeof body.client === 'string' ? body.client : 'main';
}

/** Commands after which the client restarts: `/restart` sends one of these (default `restart`). */
const RESTARTING = new Set(['restart', 'set_language']);

function restartCommand(body: Record<string, unknown>): { command: string; args: string[] } {
  const command = typeof body.command === 'string' ? body.command : 'restart';
  if (!RESTARTING.has(command)) throw new OgwError(`not a command that restarts the client: ${command}`);
  const args = Array.isArray(body.args) ? body.args.filter((a): a is string => typeof a === 'string') : [];
  return { command, args };
}

/** The long-lived process of one instance: it owns the server process, the clients, the automation channels and the bot loops. */
export class Supervisor {
  private readonly id: string;
  private readonly env: NodeJS.ProcessEnv;
  private record!: InstanceRecord;
  private plan!: InstancePlan;
  private folder = '';
  private readonly channels = new Map<string, ClientChannel>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly gate = new BotGate();
  private control: Server | null = null;
  private controlToken = '';
  /** Restricted token of the play access file: input, capture, observation and step mode only. */
  private playToken = '';
  private stopping = false;
  private stopped!: Promise<void>;
  private markStopped!: () => void;

  constructor(id: string, env: NodeJS.ProcessEnv) {
    this.id = id;
    this.env = env;
    this.stopped = new Promise((resolvePromise) => {
      this.markStopped = resolvePromise;
    });
  }

  log(line: string): void {
    try {
      appendFileSync(join(this.folder, 'runner.log'), `${new Date().toISOString()} ${line}\n`);
    } catch {
      // the instance folder is gone after stop
    }
  }

  /** Starts everything, records `running` or `failed`, and resolves when the instance stops. */
  async run(): Promise<void> {
    this.record = await readRecord(this.id, this.env);
    if (!this.record.plan) throw new OgwError(`instance ${this.id} has no plan`);
    this.plan = this.record.plan;
    if (this.stopping) return;
    this.folder = await instanceFolder(this.id, this.env);
    mkdirSync(this.folder, { recursive: true });
    await this.startControl();
    try {
      await this.boot();
      await this.writePlayAccess();
      await updateRecord(this.id, (r) => {
        r.status = 'running';
      }, this.env);
      this.log('running');
    } catch (error) {
      const message = (error as Error).message;
      this.log(`start failed: ${message}`);
      await this.shutdown();
      await updateRecord(this.id, (r) => {
        r.status = 'failed';
        r.error = message;
        r.failure = error instanceof FixtureError ? 'fixture' : 'start';
      }, this.env).catch(() => undefined);
      await this.closeControl();
      return;
    }
    await this.stopped;
  }

  // ---- control channel -------------------------------------------------------------------------

  private async startControl(): Promise<void> {
    this.controlToken = randomBytes(32).toString('base64url');
    this.playToken = randomBytes(32).toString('base64url');
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.control = server;
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const port = (server.address() as AddressInfo).port;
    await updateRecord(this.id, (r) => {
      r.supervisorPid = process.pid;
      r.control = { port, token: this.controlToken };
    }, this.env);
  }

  private async closeControl(): Promise<void> {
    const server = this.control;
    this.control = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => server.close(() => {
      resolvePromise();
    }));
  }

  /** The play access file: the control port with the play token, for the play commands. */
  private async writePlayAccess(): Promise<void> {
    const port = this.control ? (this.control.address() as AddressInfo).port : 0;
    await writePlayAccess(
      {
        id: this.id,
        port,
        token: this.playToken,
        clients: plannedClients(this.plan).map((c) => c.name),
        commandTimeoutMs: this.plan.commandTimeoutMs,
        videoMaxMs: this.plan.videoMaxMs ?? null,
        feedbackWindowMs: this.plan.feedbackWindowMs ?? null,
        targetFps: this.plan.targetFps ?? null,
      },
      this.env,
    );
  }

  /** Which token the request carries: the full control token, the play token, or neither. */
  private access(req: IncomingMessage): 'full' | 'play' | null {
    const given = Buffer.from(req.headers.authorization ?? '');
    const matches = (token: string): boolean => {
      const expected = Buffer.from(`Bearer ${token}`);
      return given.length === expected.length && timingSafeEqual(given, expected);
    };
    if (matches(this.controlToken)) return 'full';
    return matches(this.playToken) ? 'play' : null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const access = this.access(req);
    if (req.method !== 'POST' || access === null) {
      send(401, { error: 'unauthorized' });
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const parsed: unknown = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const body = isPlainObject(parsed) ? parsed : {};
      const refusal = access === 'play' ? playAccessRefusal(req.url ?? '', body) : null;
      if (refusal !== null) {
        send(403, { error: refusal });
        return;
      }
      const result = await this.route(req.url ?? '', body);
      send(200, result);
      if (req.url === '/stop') {
        await this.closeControl();
        this.markStopped();
      }
    } catch (error) {
      send(500, { error: (error as Error).message });
    }
  }

  private async route(path: string, body: Record<string, unknown>): Promise<unknown> {
    switch (path) {
      case '/request':
        return this.forward(body);
      case '/restart':
        return this.restart(clientName(body), typeof body.timeoutMs === 'number' ? body.timeoutMs : START_LIMIT_MS, restartCommand(body));
      case '/bots/pause':
        await this.gate.pause();
        return {};
      case '/bots/resume':
        this.gate.resume(typeof body.stepMode === 'boolean' ? body.stepMode : null);
        return {};
      case '/stepping':
        this.gate.setStepping(body.active === true);
        return {};
      case '/stop':
        await this.shutdown();
        return {};
      default:
        throw new OgwError(`unknown control path: ${path}`);
    }
  }

  private channel(name: string): ClientChannel {
    const channel = this.channels.get(name);
    if (!channel) throw new OgwError(`instance ${this.id} has no client ${name}`);
    return channel;
  }

  private async forward(body: Record<string, unknown>): Promise<unknown> {
    const channel = this.channel(clientName(body));
    const command = String(body.command);
    const args = Array.isArray(body.args) ? body.args.map(String) : [];
    const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : this.plan.commandTimeoutMs + LIMITS.shortMs;
    const framesDir = typeof body.framesDir === 'string' ? body.framesDir : null;
    const framePaths: string[] = [];
    let onFrame: FrameHandler | null = null;
    if (framesDir !== null) {
      mkdirSync(framesDir, { recursive: true });
      onFrame = (n, png) => {
        const path = join(framesDir, `frame-${String(n).padStart(5, '0')}.png`);
        writeFileSync(path, png);
        framePaths.push(path);
      };
    }
    const response = await channel.request(command, args, timeoutMs, onFrame);
    return {
      ok: response.ok,
      result: response.result,
      bytes: response.bytes.toString('base64'),
      frames: response.frames.map((f) => f.toString('base64')),
      framePaths,
    };
  }

  /** Sends `restart` (or another command that restarts the client) and waits until the new boot reaches `Done`. */
  private async restart(name: string, timeoutMs: number, sent = { command: 'restart', args: [] as string[] }): Promise<unknown> {
    const channel = this.channel(name);
    const generation = channel.generation;
    const response = await channel.request(sent.command, sent.args, this.plan.commandTimeoutMs + LIMITS.shortMs);
    if (!response.ok) throw new OgwError(`${sent.command} failed: ${JSON.stringify(response.result)}`);
    await channel.waitGeneration(generation, timeoutMs);
    return waitBootDone(this.requester(name), timeoutMs, this.plan.commandTimeoutMs + LIMITS.shortMs);
  }

  requester(name: string): Requester {
    const channel = this.channel(name);
    return (command, args, timeoutMs) => channel.request(command, args, timeoutMs);
  }

  // ---- start -----------------------------------------------------------------------------------

  private async boot(): Promise<void> {
    const deadline = Date.now() + START_LIMIT_MS;
    const left = (): number => Math.max(0, deadline - Date.now());
    const secrets = newLocalSecrets();
    const db = await this.database(left());
    const port = await freePort();
    const serverUrl = `http://127.0.0.1:${String(port)}`;
    const secretFile = join(this.folder, 'server-secrets.json');
    writeSecretFile(secretFile, serverSecretValues(secrets, db));
    this.spawn('server', serverLaunch({ root: this.record.root, port, db, matchmaker: this.plan.realtime, secretFile }));
    await updateRecord(this.id, (r) => {
      r.serverUrl = serverUrl;
      r.adminSecret = secrets.adminSecret;
    }, this.env);
    await this.waitServer(serverUrl, left());
    if (this.plan.populate) await this.populate(populateLaunch({ root: this.record.root, serverUrl, secretFile }), left());
    await this.startClients(serverUrl, secrets, left());
    await this.startBots();
    if (this.plan.fixture) await this.runFixture(left());
  }

  private async database(timeoutMs: number): Promise<ServerDb> {
    if (this.plan.db === 'sqlite') return { kind: 'sqlite', file: join(this.folder, 'db.sqlite') };
    const container = await startPostgres(this.id, this.plan.postgresImage ?? '', timeoutMs, this.env, () => this.stopping);
    // a stop that came while the container started removed nothing or removed it before it existed
    if (this.stopping) {
      await removePostgres(this.id, this.env);
      throw new OgwError('the instance is stopping');
    }
    await updateRecord(this.id, (r) => {
      r.container = container.name;
    }, this.env);
    return { kind: 'postgresql', url: container.url };
  }

  private spawn(name: string, launch: Launch): ChildProcess {
    if (this.stopping) throw new OgwError('the instance is stopping');
    const out = openSync(join(this.folder, `${name}.log`), 'a');
    const child = spawnTracked(launch.command, launch.args, { cwd: launch.cwd, env: this.env, stdio: ['ignore', out, out] });
    closeSync(out);
    this.children.set(name, child);
    child.on('error', (error) => {
      this.log(`${name}: ${error.message}`);
    });
    child.on('exit', (code) => {
      if (this.stopping) return;
      this.log(`${name} exited with ${String(code)}`);
      void updateRecord(this.id, (r) => {
        r.exited[name] = code;
      }, this.env).catch(() => undefined);
    });
    if (child.pid !== undefined) {
      const pid = child.pid;
      void updateRecord(this.id, (r) => {
        r.pids[name] = pid;
      }, this.env).catch(() => undefined);
    }
    return child;
  }

  private exitedEarly(name: string): boolean {
    const child = this.children.get(name);
    return child !== undefined && (child.exitCode !== null || child.signalCode !== null);
  }

  /** Waits until the server process answers HTTP at all. */
  private async waitServer(serverUrl: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.exitedEarly('server')) throw new OgwError('the server process ended before it took requests');
      if (await answers(`${serverUrl}/update/deploy_list.json`)) return;
      if (Date.now() >= deadline) throw new OgwError(`the server process did not take requests within ${String(timeoutMs)} ms`);
      await sleep(200);
    }
  }

  private async populate(launch: Launch, timeoutMs: number): Promise<void> {
    const result = await run(launch.command, launch.args, { cwd: launch.cwd, env: this.env, timeoutMs });
    appendFileSync(join(this.folder, 'populate.log'), result.stdout + result.stderr);
    if (result.timedOut) throw new OgwError(`populate did not end within ${String(timeoutMs)} ms`);
    if (result.code !== 0) throw new OgwError(`populate failed: ${(result.stderr || result.stdout).trim()}`);
  }

  /** The automation channel `main` of a client the runner does not start, and its launch values in the record. */
  private async openExternal(secrets: LocalSecrets): Promise<void> {
    const channel = new ClientChannel('main');
    await channel.listen();
    this.channels.set('main', channel);
    await updateRecord(this.id, (r) => {
      r.external = { automationPort: channel.port, automationToken: channel.token, devAccess: secrets.devAccess, devAccount: MAIN_DEV_ACCOUNT };
    }, this.env);
  }

  private async startClients(serverUrl: string, secrets: LocalSecrets, timeoutMs: number): Promise<void> {
    if (this.plan.external === true) await this.openExternal(secrets);
    const clients = plannedClients(this.plan);
    for (const client of clients) {
      const channel = new ClientChannel(client.name);
      await channel.listen();
      this.channels.set(client.name, channel);
      const values: LaunchValues = {
        OGW_SERVER_URL: serverUrl,
        OGW_INSTANCE_ID: this.id,
        OGW_AUTOMATION_PORT: String(channel.port),
        OGW_AUTOMATION_TOKEN: channel.token,
        OGW_DEV_ACCOUNT: client.account,
        OGW_DEV_ACCESS: secrets.devAccess,
        OGW_PLATFORM: this.record.platform,
      };
      const valueFile = join(this.folder, `${client.name}.launch-values.json`);
      writeSecretFile(valueFile, launchValueFileContent(values));
      this.spawn(client.name, clientLaunch(this.plan, this.record.root, client.headless, valueFile, client.name === 'main' ? (this.plan.movie ?? null) : null));
    }
    await Promise.all(clients.map(async (client) => {
      try {
        // a client without a dev account is played by an agent and may wait on the terms popup: only its channel counts
        await this.waitClient(client.name, client.account !== '', timeoutMs);
      } catch (error) {
        throw new OgwError(`${client.name}: ${(error as Error).message}`);
      }
    }));
  }

  /** Waits until the client reached `boot_stage` `Done`, or with `done` false until its automation channel connected. */
  private async waitClient(name: string, done: boolean, timeoutMs: number): Promise<unknown> {
    if (this.exitedEarly(name)) throw new OgwError('the client process ended');
    const exited = new Promise<never>((_, reject) => {
      const child = this.children.get(name);
      child?.once('exit', (code) => {
        reject(new OgwError(`the client process ended with ${String(code)}`));
      });
    });
    exited.catch(() => undefined);
    const ready = done
      ? waitBootDone(this.requester(name), timeoutMs, this.plan.commandTimeoutMs + LIMITS.shortMs)
      : this.channel(name).waitConnected(timeoutMs);
    return Promise.race([ready, exited]);
  }

  private async startBots(): Promise<void> {
    const commandMs = this.plan.commandTimeoutMs + LIMITS.shortMs;
    const log = (line: string): void => {
      this.log(line);
    };
    if (this.plan.opponents.length > 0) {
      const names = commandNames((await this.requester(opponentName(0))('list_commands', [], commandMs)).result);
      const step = oneCommand(names, '.opponent_step');
      const rooms = this.plan.opponents.some(roomCapable);
      const joinRoom = rooms ? oneCommand(names, '.opponent_join_room') : null;
      const bots: OpponentBot[] = this.plan.opponents.map((row, i) => ({
        name: opponentName(i),
        row,
        request: this.requester(opponentName(i)),
        pendingJoin: null,
      }));
      for (const bot of bots) void opponentLoop(this.gate, bot, { step, joinRoom, timeoutMs: commandMs }, log);
      if (rooms && this.channels.has('main')) void roomWatch(this.gate, this.requester('main'), bots, this.plan.opponents, commandMs, log);
    }
    if (this.plan.social && this.channels.has('main')) {
      const names = commandNames((await this.requester('social')('list_commands', [], commandMs)).result);
      const step = oneCommand(names, '.social_step');
      // the client `main` may log in after the instance started (an outside client, the terms popup of a new user)
      void this.mainUserId(commandMs).then((userId) => {
        if (userId !== null) void socialLoop(this.gate, this.requester('social'), step, String(userId), commandMs, log);
      });
    }
  }

  /** The `user_id` of the client `main` once it is not 0; null when the instance stops first. */
  private async mainUserId(commandMs: number): Promise<number | null> {
    for (;;) {
      if (this.stopping) return null;
      const state = await getState(this.requester('main'), commandMs).catch(() => null);
      if (typeof state?.user_id === 'number' && state.user_id !== 0) return state.user_id;
      await sleep(200);
    }
  }

  private async runFixture(timeoutMs: number): Promise<void> {
    const steps = this.plan.fixture ?? [];
    const request = this.requester('main');
    try {
      for (const [i, step] of steps.entries()) await runStep(request, step, i);
      await this.restart('main', timeoutMs);
    } catch (error) {
      throw new FixtureError((error as Error).message);
    }
  }

  // ---- stop ------------------------------------------------------------------------------------

  /** Stops everything and ends `run`. */
  async terminate(): Promise<void> {
    await this.shutdown();
    await this.closeControl();
    this.markStopped();
  }

  /** Stops the bot loops, the clients, the server process and the DB container. */
  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await deletePlayAccess(this.id, this.env).catch(() => undefined);
    this.gate.stop();
    await Promise.all([...this.children.values()].map(stopChild));
    await Promise.all([...this.channels.values()].map((c) => c.close()));
    if (this.plan.db === 'postgresql') await removePostgres(this.id, this.env);
    this.log('stopped');
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>((resolvePromise) => child.once('exit', () => {
    resolvePromise();
  }));
  killTree(child, 'SIGTERM');
  const timer = setTimeout(() => {
    killTree(child, 'SIGKILL');
  }, KILL_GRACE_MS);
  await ended;
  clearTimeout(timer);
}

/** True when an HTTP server answers the URL with any status. */
function answers(url: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const req = httpRequest(url, { method: 'GET', timeout: 2000 }, (res) => {
      res.resume();
      resolvePromise(true);
    });
    req.on('timeout', () => {
      req.destroy();
    });
    req.on('error', () => {
      resolvePromise(false);
    });
    req.end();
  });
}

/** Runs the supervisor of an instance in this process until the instance stops. */
export async function runSupervisor(id: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await new Supervisor(id, env).run();
}
