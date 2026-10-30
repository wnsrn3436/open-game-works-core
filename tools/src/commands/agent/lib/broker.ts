// The broker of a play or judge agent (ogw.md `## agent`): a unix socket server that the `ogw agent` job runs
// outside the agent's sandbox while the agent CLI runs. Each `ogw` call inside the sandbox sends its argv, cwd and
// agent key here; the broker checks the key and the command and runs the command as that agent in the broker sandbox.
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { lineReader, STDIN_REQUEST, STDIN_STREAM_REQUEST, type BrokerMessage, type BrokerRequest } from '../../../lib/broker-client.ts';
import { createContext } from '../../../lib/command.ts';
import { killTree, spawnTracked } from '../../../lib/proc.ts';
import type { CliCommand } from './cli-command.ts';
import { brokerBudgetRefusal } from './play-budget.ts';

/**
 * The broker commands (ogw.md `## agent`): the only commands a broker runs, with their `--help`. The commands the
 * play and judge documents have those agents run, and the commands that wait on a job.
 */
export const BROKER_COMMANDS: readonly (readonly string[])[] = [
  ['input'],
  ['capture'],
  ['log'],
  ['telemetry'],
  ['telemetry', 'compare'],
  ['step-mode'],
  ['step'],
  ['frames'],
  ['instance', 'release'],
  ['instance', 'wait'],
  ['job', 'status'],
  ['job', 'wait'],
];

/** The broker command of argv: the one whose name is the longest prefix of argv, or null. */
export function brokerCommand(argv: readonly string[]): readonly string[] | null {
  let best: readonly string[] | null = null;
  for (const name of BROKER_COMMANDS) {
    if (name.length > argv.length || !name.every((word, i) => argv[i] === word)) continue;
    if (best === null || name.length > best.length) best = name;
  }
  return best;
}

/**
 * The broker commands the broker worker runs (ogw.md `## agent`): the ones play and judge agents call many times in
 * a row, which end soon after they start. The others start a process each.
 */
export const WORKER_COMMANDS: readonly (readonly string[])[] = [['input'], ['capture'], ['log'], ['telemetry'], ['step-mode'], ['step'], ['frames']];

/** True when the broker worker runs argv: a `WORKER_COMMANDS` command that does not start a background job. */
export function workerRuns(argv: readonly string[]): boolean {
  const name = brokerCommand(argv);
  return name !== null && WORKER_COMMANDS.some((worker) => worker.join(' ') === name.join(' ')) && !argv.includes('--background');
}

/** The command words of argv for an error: the tokens before the first option, at most two. */
function commandWords(argv: readonly string[]): string {
  const end = argv.findIndex((arg) => arg.startsWith('-'));
  return ['ogw', ...argv.slice(0, Math.min(end < 0 ? argv.length : end, 2))].join(' ');
}

/** Longest line a client may send: a request, or the stdin of a command. */
const MAX_LINE = 64 * 1024 * 1024;

export interface BrokerOptions {
  /** Socket path; its folder is made owner-only (0700) and removed on close. */
  socket: string;
  /** The agent key value `<job id>.<nonce>` the agent CLI got. */
  key: string;
  /** The command that runs a forwarded argv: `ogw __broker-run <argv>` in the broker sandbox. */
  command: (argv: readonly string[]) => CliCommand;
  /**
   * The broker worker: `ogw __broker-worker` in the broker sandbox, started at the first call it runs and kept. Without
   * it every call starts `command`.
   */
  worker?: CliCommand;
  /** The environment of those commands: the agent's, with its agent key. */
  env: NodeJS.ProcessEnv;
}

export interface Broker {
  /** Stops taking calls, kills the commands still running, and removes the socket folder. */
  close(): Promise<void>;
}

function sameKey(given: string, expected: string): boolean {
  const hash = (text: string): Buffer => createHash('sha256').update(text).digest();
  return timingSafeEqual(hash(given), hash(expected));
}

function send(socket: Socket, message: BrokerMessage): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function refuse(socket: Socket, reason: string): void {
  send(socket, { stderr: `ogw broker: ${reason}\n` });
  send(socket, { exit: 1 });
  socket.end();
}

function parseRequest(text: string): BrokerRequest | null {
  try {
    const value = JSON.parse(text) as Partial<BrokerRequest>;
    const argvOk = Array.isArray(value.argv) && value.argv.every((arg) => typeof arg === 'string');
    if (!argvOk || typeof value.cwd !== 'string' || !isAbsolute(value.cwd) || typeof value.key !== 'string') return null;
    return { argv: value.argv as string[], cwd: value.cwd, key: value.key };
  } catch {
    return null;
  }
}

/** What a call takes from its caller after the request: all of stdin, or stdin chunk by chunk and its end. */
interface CallInput {
  stdin: (text: string) => void;
  chunk: (text: string) => void;
  end: () => void;
}

/** How the command of a call asked for stdin: all of it, as it comes, or not yet. */
type Asked = 'all' | 'stream' | null;

/** Runs one verified call and streams its output back; the command is killed when the caller goes away. */
function runCall(socket: Socket, request: BrokerRequest, options: BrokerOptions, children: Set<ChildProcess>): CallInput {
  const command = options.command(request.argv);
  const child = spawnTracked(command.cmd, command.args, { cwd: request.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  children.add(child);
  let asked: Asked = null;
  child.stdin?.on('error', () => undefined);
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    send(socket, { stdout: chunk });
  });
  child.stderr?.on('data', (chunk: string) => {
    send(socket, { stderr: chunk });
  });
  const requests = child.stdio[3] as Readable | null | undefined;
  requests?.setEncoding('utf8');
  requests?.on(
    'data',
    lineReader((line) => {
      if (asked !== null) return;
      if (line === STDIN_REQUEST.trim()) {
        asked = 'all';
        send(socket, { stdin: true });
      } else if (line === STDIN_STREAM_REQUEST.trim()) {
        asked = 'stream';
        send(socket, { stdinStream: true });
      }
    }),
  );
  requests?.on('error', () => undefined);
  let ended = false;
  const end = (code: number, reason?: string): void => {
    if (ended) return;
    ended = true;
    children.delete(child);
    if (reason !== undefined) send(socket, { stderr: `ogw broker: ${reason}\n` });
    send(socket, { exit: code });
    socket.end();
  };
  child.on('error', (error) => {
    end(1, `cannot run the command in ${request.cwd}: ${error.message}`);
  });
  // The call ends when the command exited and its stdout and stderr ended. Not on `close`: a background job the
  // command started keeps an inherited copy of fd 3 open. The processes the command left in its process group end
  // with it, so its output pipes close.
  let exitCode: number | null | undefined;
  let open = 2;
  const maybeEnd = (): void => {
    if (exitCode !== undefined && open === 0) end(exitCode ?? 1);
  };
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('close', () => {
      open--;
      maybeEnd();
    });
  }
  child.on('exit', (code) => {
    killTree(child, 'SIGKILL');
    requests?.destroy();
    exitCode = code;
    maybeEnd();
  });
  socket.on('close', () => {
    if (children.has(child)) killTree(child, 'SIGKILL');
  });
  return {
    stdin: (text) => {
      if (asked === 'all') child.stdin?.end(text);
    },
    chunk: (text) => {
      if (asked === 'stream') child.stdin?.write(text);
    },
    end: () => {
      if (asked === 'stream') child.stdin?.end();
    },
  };
}

interface WorkerCall {
  socket: Socket;
  asked: Asked;
  end: (code: number, reason?: string) => void;
}

/**
 * The broker worker process (`broker-worker.ts`): started at the first call it runs, it runs one call at a time. A
 * call whose caller goes away kills it, as its command cannot be stopped alone; the next call starts a new one.
 */
class BrokerWorker {
  private readonly command: CliCommand;
  private readonly env: NodeJS.ProcessEnv;
  private readonly children: Set<ChildProcess>;
  private child: ChildProcess | null = null;
  private call: WorkerCall | null = null;

  constructor(command: CliCommand, env: NodeJS.ProcessEnv, children: Set<ChildProcess>) {
    this.command = command;
    this.env = env;
    this.children = children;
  }

  /** True while a call runs; a call that comes meanwhile starts a process of its own. */
  get busy(): boolean {
    return this.call !== null;
  }

  private start(cwd: string): ChildProcess {
    const child = spawnTracked(this.command.cmd, this.command.args, { cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    this.children.add(child);
    child.stdin?.on('error', () => undefined);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    // output the commands write past their io goes to the call that runs
    child.stdout?.on('data', (chunk: string) => {
      if (this.call !== null) send(this.call.socket, { stdout: chunk });
    });
    child.stderr?.on('data', (chunk: string) => {
      if (this.call !== null) send(this.call.socket, { stderr: chunk });
    });
    const messages = child.stdio[3] as Readable | null | undefined;
    messages?.setEncoding('utf8');
    messages?.on('error', () => undefined);
    messages?.on(
      'data',
      lineReader((text) => {
        const call = this.call;
        if (call === null) return;
        let message: BrokerMessage;
        try {
          message = JSON.parse(text) as BrokerMessage;
        } catch {
          return;
        }
        if (typeof message.stdout === 'string') send(call.socket, { stdout: message.stdout });
        else if (typeof message.stderr === 'string') send(call.socket, { stderr: message.stderr });
        else if (message.stdin === true && call.asked === null) {
          call.asked = 'all';
          send(call.socket, { stdin: true });
        } else if (message.stdinStream === true && call.asked === null) {
          call.asked = 'stream';
          send(call.socket, { stdinStream: true });
        } else if (typeof message.exit === 'number') call.end(message.exit);
      }),
    );
    const gone = (reason: string): void => {
      if (this.child !== child) return;
      this.child = null;
      this.children.delete(child);
      this.call?.end(1, reason);
    };
    child.on('error', (error) => {
      gone(`cannot run the broker worker: ${error.message}`);
    });
    child.on('exit', () => {
      killTree(child, 'SIGKILL');
      gone('the broker worker ended');
    });
    this.child = child;
    return child;
  }

  private kill(): void {
    const child = this.child;
    if (child === null) return;
    this.child = null;
    this.children.delete(child);
    killTree(child, 'SIGKILL');
  }

  /** Runs one verified call and streams its output back. */
  run(socket: Socket, request: BrokerRequest): CallInput {
    const child = this.child ?? this.start(request.cwd);
    const call: WorkerCall = {
      socket,
      asked: null,
      end: (code, reason) => {
        if (this.call !== call) return;
        this.call = null;
        if (reason !== undefined) send(socket, { stderr: `ogw broker: ${reason}\n` });
        send(socket, { exit: code });
        socket.end();
      },
    };
    this.call = call;
    socket.on('close', () => {
      if (this.call !== call) return;
      this.call = null;
      this.kill();
    });
    child.stdin?.write(`${JSON.stringify({ argv: request.argv, cwd: request.cwd })}\n`);
    const pass = (asked: Asked, line: unknown): void => {
      if (call.asked === asked && this.call === call) child.stdin?.write(`${JSON.stringify(line)}\n`);
    };
    return {
      stdin: (text) => {
        pass('all', { stdin: text });
      },
      chunk: (text) => {
        pass('stream', { chunk: text });
      },
      end: () => {
        pass('stream', { end: true });
      },
    };
  }
}

function serve(socket: Socket, options: BrokerOptions, children: Set<ChildProcess>, worker: BrokerWorker | null): void {
  socket.setEncoding('utf8');
  socket.on('error', () => undefined);
  let call: CallInput | null = null;
  // set once the request line is read: a later line before the command runs is not a request
  let requested = false;
  let size = 0;
  const read = lineReader((text) => {
    if (call === null) {
      if (requested) {
        socket.destroy();
        return;
      }
      requested = true;
      const request = parseRequest(text);
      if (request === null) refuse(socket, 'the request is not {"argv": [...], "cwd": "<absolute path>", "key": "..."}');
      else if (!sameKey(request.key, options.key)) refuse(socket, 'the agent key (OGW_AGENT_KEY) is not the key of this agent');
      else if (brokerCommand(request.argv) === null) {
        const allowed = BROKER_COMMANDS.map((name) => `ogw ${name.join(' ')}`).join(', ');
        refuse(socket, `${commandWords(request.argv)} is not a command of the play and judge agents; they run only ${allowed}`);
      } else {
        // a play agent past its play budget is refused here, before a command starts
        const ctx = createContext({ cwd: request.cwd, env: options.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
        void brokerBudgetRefusal(ctx, request.argv).then(
          (refusal) => {
            // a client gone during the check gets no command, which nothing would end
            if (socket.destroyed) return;
            if (refusal !== null) refuse(socket, refusal);
            else if (worker !== null && !worker.busy && workerRuns(request.argv)) call = worker.run(socket, request);
            else call = runCall(socket, request, options, children);
          },
          (error: unknown) => {
            refuse(socket, `the play budget could not be read: ${error instanceof Error ? error.message : String(error)}`);
          },
        );
      }
      return;
    }
    try {
      const { stdin, chunk, end } = JSON.parse(text) as { stdin?: unknown; chunk?: unknown; end?: unknown };
      if (typeof stdin === 'string') call.stdin(stdin);
      else if (typeof chunk === 'string') call.chunk(chunk);
      else if (end === true) call.end();
    } catch {
      socket.destroy();
    }
  });
  socket.on('data', (chunk: string) => {
    size += chunk.length;
    if (size > MAX_LINE) {
      socket.destroy();
      return;
    }
    read(chunk);
  });
}

/** Opens the broker socket. The caller closes it when the agent CLI ends. */
export async function startBroker(options: BrokerOptions): Promise<Broker> {
  const folder = dirname(options.socket);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  const children = new Set<ChildProcess>();
  const sockets = new Set<Socket>();
  const worker = options.worker === undefined ? null : new BrokerWorker(options.worker, options.env, children);
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    serve(socket, options, children, worker);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.socket, () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  return {
    async close() {
      await new Promise<void>((resolvePromise) => {
        server.close(() => {
          resolvePromise();
        });
        for (const child of children) killTree(child, 'SIGKILL');
        for (const socket of sockets) socket.destroy();
      });
      await rm(folder, { recursive: true, force: true });
    },
  };
}
