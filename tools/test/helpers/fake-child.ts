// In-process stand-ins for the programs a test would start as child processes. A test file mocks `node:child_process`
// with `fakeSpawn`; `spawn` then counts every command it is given and starts the program `fakeProgram` set for a
// command in this process, so what that program sends does not wait for a process to boot. Other commands start real
// processes. A signal to a fake's pid or process group (`killTree`) ends the fake as it ends a process.
import type * as ChildProcessModule from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

export type FakeProgram = (child: FakeChild) => void;

/** Above the largest pid an OS gives (Linux `pid_max` is at most 2^22), so a signal to a fake pid reaches no process. */
const FIRST_PID = 2 ** 30;

const programs = new Map<string, FakeProgram>();
const commands: string[] = [];
const running = new Map<number, FakeChild>();
let nextPid = FIRST_PID;

/** One started fake: its arguments, its pipes, and its end as a process. */
export class FakeChild extends EventEmitter {
  readonly pid = nextPid++;
  readonly args: readonly string[];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin: Writable | null;
  readonly stdout: PassThrough | null;
  readonly stderr: PassThrough | null;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(args: readonly string[], stdio: ChildProcessModule.StdioOptions | undefined) {
    super();
    this.args = args;
    const pipe = (fd: number): boolean => {
      const kind = typeof stdio === 'string' || stdio === undefined ? stdio ?? 'pipe' : stdio[fd] ?? 'pipe';
      return kind === 'pipe' || kind === 'overlapped';
    };
    this.stdin = pipe(0) ? new Writable({ write: (_chunk, _encoding, done) => { done(); } }) : null;
    this.stdout = pipe(1) ? new PassThrough() : null;
    this.stderr = pipe(2) ? new PassThrough() : null;
  }

  /** Runs `fn` after `ms`, unless the fake ended before. */
  after(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  /** Ends the fake as a process that exits with `code`. */
  exit(code: number): void {
    this.end(code, null);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.end(null, signal);
    return true;
  }

  /** `exit` once, then `close` when the pipes have ended, as a process gives them. */
  end(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    running.delete(this.pid);
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    const pipes = [this.stdout, this.stderr].filter((p) => p !== null);
    const ended = pipes.map((p) => once(p, 'end'));
    for (const p of pipes) p.resume().end();
    void Promise.all(ended).then(() => this.emit('close', code, signal));
  }
}

/** From now on `spawn` of `command` starts `program` in this process in place of a process. */
export function fakeProgram(command: string, program: FakeProgram): void {
  programs.set(command, program);
}

/** How many times `spawn` was given `command`. */
export function spawnCount(command: string): number {
  return commands.filter((c) => c === command).length;
}

/** Delivers a signal to a fake pid or process group; a fake pid that is not running is a process that is gone. */
function installKill(): void {
  const real = process.kill.bind(process);
  process.kill = (pid: number, signal?: string | number): true => {
    if (Math.abs(pid) < FIRST_PID) return real(pid, signal);
    const child = running.get(Math.abs(pid));
    if (child === undefined) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH', syscall: 'kill' });
    if (signal !== 0) child.end(null, typeof signal === 'string' ? (signal as NodeJS.Signals) : 'SIGTERM');
    return true;
  };
}

/** The `node:child_process` module with the `spawn` that starts the fakes of `fakeProgram` and counts commands. */
export function fakeSpawn(real: typeof ChildProcessModule): typeof ChildProcessModule {
  installKill();
  const spawn = (command: string, ...rest: unknown[]): ChildProcessModule.ChildProcess => {
    commands.push(command);
    const program = programs.get(command);
    if (program === undefined) return Reflect.apply(real.spawn, real, [command, ...rest]) as ChildProcessModule.ChildProcess;
    const args = Array.isArray(rest[0]) ? (rest[0] as string[]) : [];
    const options = (Array.isArray(rest[0]) ? rest[1] : rest[0]) as ChildProcessModule.SpawnOptions | undefined;
    const child = new FakeChild(args, options?.stdio);
    running.set(child.pid, child);
    // a process begins after `spawn` returns, once its caller has added its listeners
    setImmediate(() => {
      program(child);
    });
    return child as unknown as ChildProcessModule.ChildProcess;
  };
  return { ...real, spawn: spawn as typeof real.spawn };
}
