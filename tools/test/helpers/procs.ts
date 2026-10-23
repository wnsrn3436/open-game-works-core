import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isAlive } from '../../src/lib/proc.ts';

const PROC_TS = resolve(import.meta.dirname, '../../src/lib/proc.ts');

export interface TrackedParent {
  /** A node process in its own process group, as a job command process is. */
  parent: ChildProcess;
  /** pid of a `sleep` the parent started with `spawnTracked` (its own process group). */
  child: number;
}

/**
 * Starts a node process that starts `sleep 60` with `spawnTracked` and waits. With `ownHandler` it also has its own
 * SIGTERM handler; with `ignoreTerm` it has only its own SIGTERM handler and starts no tracked child.
 */
export async function startTrackedParent(dir: string, options: { ownHandler?: boolean; ignoreTerm?: boolean } = {}): Promise<TrackedParent> {
  const script = join(dir, `parent-${String(Date.now())}-${String(Math.random()).slice(2)}.mjs`);
  const lines = options.ignoreTerm
    ? ["process.on('SIGTERM', () => undefined);", "process.stdout.write('0\\n');"]
    : [
        `const { spawnTracked } = await import(${JSON.stringify(PROC_TS)});`,
        "const child = spawnTracked('sleep', ['60'], { stdio: 'ignore' });",
        ...(options.ownHandler ? ["process.on('SIGTERM', () => undefined);"] : []),
        'process.stdout.write(`${String(child.pid)}\\n`);',
      ];
  writeFileSync(script, [...lines, 'setInterval(() => undefined, 1000);', ''].join('\n'));
  const parent = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const child = await new Promise<number>((resolvePromise, reject) => {
    let out = '';
    parent.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.includes('\n')) resolvePromise(Number(out.trim()));
    });
    parent.on('exit', () => {
      reject(new Error('parent ended before it started its child'));
    });
  });
  return { parent, child };
}

/** A `sleep 60` in its own process group, standing for an agent CLI process. */
export function startSleeper(): ChildProcess {
  return spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
}

/** Waits until the pid is gone; returns whether it is gone. */
export async function waitDead(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) await sleep(50);
  return !isAlive(pid);
}

/** Exit code or signal of a child once it ends. */
export function ended(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolvePromise) => {
    child.on('exit', (code, signal) => {
      resolvePromise({ code, signal });
    });
  });
}

/** Kills what a test left running. */
export function cleanup(pids: readonly (number | undefined)[]): void {
  for (const pid of pids) {
    if (pid === undefined) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
  }
}
