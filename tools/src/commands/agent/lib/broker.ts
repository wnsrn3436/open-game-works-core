// The broker of a play or judge agent (ogw.md `## agent`): a unix socket server that the `ogw agent` job runs
// outside the agent's sandbox while the agent CLI runs. Each `ogw` call inside the sandbox sends its argv, cwd and
// agent key here; the broker checks the key and the command and runs the command as that agent in the broker sandbox.
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { lineReader, STDIN_REQUEST, type BrokerMessage, type BrokerRequest } from '../../../lib/broker-client.ts';
import { killTree, spawnTracked } from '../../../lib/proc.ts';
import type { CliCommand } from './cli-command.ts';

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
  /** The environment of that command: the agent's, with its agent key. */
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

/** Runs one verified call and streams its output back; the command is killed when the caller goes away. */
function runCall(socket: Socket, request: BrokerRequest, options: BrokerOptions, children: Set<ChildProcess>): { stdin: (text: string) => void } {
  const command = options.command(request.argv);
  const child = spawnTracked(command.cmd, command.args, { cwd: request.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  children.add(child);
  let asked = false;
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
  requests?.on('data', (chunk: Buffer) => {
    if (!asked && chunk.toString('utf8').includes(STDIN_REQUEST.trim())) {
      asked = true;
      send(socket, { stdin: true });
    }
  });
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
      if (asked) child.stdin?.end(text);
    },
  };
}

function serve(socket: Socket, options: BrokerOptions, children: Set<ChildProcess>): void {
  socket.setEncoding('utf8');
  socket.on('error', () => undefined);
  let call: { stdin: (text: string) => void } | null = null;
  let size = 0;
  const read = lineReader((text) => {
    if (call === null) {
      const request = parseRequest(text);
      if (request === null) refuse(socket, 'the request is not {"argv": [...], "cwd": "<absolute path>", "key": "..."}');
      else if (!sameKey(request.key, options.key)) refuse(socket, 'the agent key (OGW_AGENT_KEY) is not the key of this agent');
      else if (brokerCommand(request.argv) === null) {
        const allowed = BROKER_COMMANDS.map((name) => `ogw ${name.join(' ')}`).join(', ');
        refuse(socket, `${commandWords(request.argv)} is not a command of the play and judge agents; they run only ${allowed}`);
      } else call = runCall(socket, request, options, children);
      return;
    }
    try {
      const { stdin } = JSON.parse(text) as { stdin?: unknown };
      if (typeof stdin === 'string') call.stdin(stdin);
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
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    serve(socket, options, children);
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
