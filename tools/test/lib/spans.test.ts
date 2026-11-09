// Spans and waits of a job (ogw.md `## time`): the steps a command names nest by async context, each lock, slot and
// ledger helper records its waits on the path that names what it waits for, and a killed job keeps what it wrote.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gitRaw, WORKTREE_LOCK } from '../../src/lib/git.ts';
import { readJob, startJob, waitJob } from '../../src/lib/jobs.ts';
import { withLock, withLockWithin } from '../../src/lib/lock.ts';
import { withReader, withWriter, withWriterWithin } from '../../src/lib/rwlock.ts';
import { withShare } from '../../src/lib/shares.ts';
import { withSlot } from '../../src/lib/slots.ts';
import { inJob, span, spanContext, type SpanLine } from '../../src/lib/spans.ts';
import { commitAll, gitInit, makeWorkspace } from '../helpers/workspace.ts';

function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'ogw-spans-')));
}

function linesOf(path: string): SpanLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as SpanLine);
}

/** The wait lines of a spans file that have ended. */
function endedWaits(path: string): { wait: string; parent: string | null; ms: number }[] {
  return linesOf(path).flatMap((line) => ('wait' in line && line.end !== null ? [{ wait: line.wait, parent: line.parent, ms: line.end - line.start }] : []));
}

/**
 * Holds a lock outside any job: `hold` takes it and runs the function it is given while holding it, which keeps it for
 * `ms`. `held` settles once it holds it, `done` once it let it go.
 */
function holdFor(ms: number, hold: (whileHeld: () => Promise<void>) => Promise<unknown>): { held: Promise<void>; done: Promise<unknown> } {
  let entered: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const done = hold(() => {
    entered();
    return sleep(ms);
  });
  return { held, done };
}

describe('span', () => {
  it('nests step spans by async context and writes each once at its start and once at its end', async () => {
    const file = join(tempDir(), 'j1.spans.jsonl');
    await inJob('j1', file, async () => {
      expect(spanContext()).toEqual({ job: 'j1', span: null });
      await span('outer', async () => {
        const outer = spanContext()?.span ?? null;
        // two steps that run together are both in the outer one
        await Promise.all([span('a', () => sleep(20)), span('b', async () => {
          await sleep(5);
          expect(spanContext()?.span).not.toBe(outer);
        })]);
        expect(spanContext()?.span).toBe(outer);
      });
    });
    const lines = linesOf(file);
    const byName = (name: string): SpanLine[] => lines.filter((line) => 'name' in line && line.name === name);
    const [outerStart, outerEnd] = byName('outer');
    expect(outerStart).toMatchObject({ parent: null, end: null });
    expect(outerEnd).toMatchObject({ id: outerStart?.id, parent: null });
    expect(typeof outerEnd?.end).toBe('number');
    for (const name of ['a', 'b']) {
      const [start, end] = byName(name);
      expect(start).toMatchObject({ parent: outerStart?.id, end: null });
      expect(end?.end).toBeGreaterThanOrEqual(start?.start ?? Infinity);
    }
    expect(lines).toHaveLength(6);
  });

  it('makes ids of the pid, a tag of the process and a count, so that a later process with the same pid writes other ids', async () => {
    const file = join(tempDir(), 'j2.spans.jsonl');
    await inJob('j2', file, () => span('one', () => span('two', () => Promise.resolve())));
    const ids = [...new Set(linesOf(file).map((line) => line.id))];
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(new RegExp(`^${process.pid.toString(36)}[0-9a-f]{6}\\.[0-9a-z]+$`));
    // another process: its own tag
    const spans = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'spans.ts')).href;
    const script = `import { inJob, span } from ${JSON.stringify(spans)};\nawait inJob('j2', ${JSON.stringify(file)}, () => span('three', () => Promise.resolve()));`;
    const other = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(other.status, other.stderr).toBe(0);
    const tags = new Set(linesOf(file).map((line) => line.id.replace(/\.[0-9a-z]+$/, '').slice(-6)));
    expect(tags.size).toBe(2);
  });

  it('marks a step that throws as failed and passes the error on', async () => {
    const file = join(tempDir(), 'j2.spans.jsonl');
    await expect(inJob('j2', file, () => span('bad', () => Promise.reject(new Error('boom'))))).rejects.toThrow('boom');
    expect(linesOf(file).at(-1)).toMatchObject({ name: 'bad', failed: true });
  });

  it('only runs the step outside a job, and writes no file for a job that names no step and waits for nothing', async () => {
    expect(await span('alone', () => Promise.resolve(3))).toBe(3);
    expect(spanContext()).toBeNull();
    const dir = tempDir();
    const file = join(dir, 'j3.spans.jsonl');
    await inJob('j3', file, () => withLock(join(dir, 'free.lock'), () => Promise.resolve()));
    expect(existsSync(file)).toBe(false);
  });

  it('keeps the lines a killed job wrote: the steps that ended with their end, the one that ran without', async () => {
    const dir = tempDir();
    const file = join(dir, 'k1.spans.jsonl');
    const spans = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'spans.ts')).href;
    const script = [
      `import { inJob, span } from ${JSON.stringify(spans)};`,
      `await inJob('k1', ${JSON.stringify(file)}, () => span('outer', async () => {`,
      `  await span('done step', () => Promise.resolve());`,
      `  await span('hung step', () => { process.stdout.write('ready\\n'); return new Promise(() => setInterval(() => undefined, 1000)); });`,
      `}));`,
    ].join('\n');
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolveReady) => {
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready')) resolveReady();
      });
    });
    child.kill('SIGKILL');
    await new Promise((resolveExit) => child.on('exit', resolveExit));
    const lines = linesOf(file);
    const ended = (name: string): boolean => lines.some((line) => 'name' in line && line.name === name && line.end !== null);
    const started = (name: string): boolean => lines.some((line) => 'name' in line && line.name === name && line.end === null);
    expect(ended('done step')).toBe(true);
    expect(started('hung step') && !ended('hung step')).toBe(true);
    expect(started('outer') && !ended('outer')).toBe(true);
  });
});

describe('waits', () => {
  it('records a wait on the lock path of withLock when the first try does not take it, and none when it does', async () => {
    const dir = tempDir();
    const lock = join(dir, 'a.lock');
    const file = join(dir, 'w1.spans.jsonl');
    await inJob('w1', file, () => span('free', () => withLock(lock, () => Promise.resolve())));
    expect(endedWaits(file)).toEqual([]);
    const holder = holdFor(400, (whileHeld) => withLock(lock, whileHeld));
    await holder.held;
    await inJob('w1', file, () => span('busy', () => withLock(lock, () => Promise.resolve())));
    await holder.done;
    const [wait] = endedWaits(file);
    expect(wait?.wait).toBe(lock);
    expect(wait?.ms).toBeGreaterThanOrEqual(250);
    const busy = linesOf(file).find((line) => 'name' in line && line.name === 'busy');
    expect(wait?.parent).toBe(busy?.id);
  });

  it('records the wait of a take that gives up, and a wait in the job span outside any step', async () => {
    const dir = tempDir();
    const lock = join(dir, 'b.lock');
    const file = join(dir, 'w2.spans.jsonl');
    const holder = holdFor(600, (whileHeld) => withLock(lock, whileHeld));
    await holder.held;
    const outcome = await inJob('w2', file, () => withLockWithin(lock, () => Promise.resolve(1), 200));
    await holder.done;
    expect(outcome).toEqual({ ran: false });
    expect(endedWaits(file)).toEqual([{ wait: lock, parent: null, ms: expect.any(Number) as number }]);
    expect(endedWaits(file)[0]?.ms).toBeGreaterThanOrEqual(150);
  });

  it('records a wait on the git worktree lock of the repo', async () => {
    const repo = tempDir();
    gitInit(repo);
    commitAll(repo);
    const lock = join(repo, '.git', WORKTREE_LOCK);
    const file = join(tempDir(), 'w3.spans.jsonl');
    const holder = holdFor(400, (whileHeld) => withLock(lock, whileHeld));
    await holder.held;
    await inJob('w3', file, () => gitRaw(repo, ['worktree', 'list']));
    await holder.done;
    expect(endedWaits(file).map((w) => w.wait)).toEqual([lock]);
  });

  it('records the waits of readers and writers on the base of the reader/writer lock', async () => {
    const dir = tempDir();
    const lock = { base: join(dir, 'rw'), waitMs: 60_000 };
    // a reader waits for a writer that holds the lock
    const file = join(dir, 'w4.spans.jsonl');
    const writer = holdFor(400, (whileHeld) => withWriter(lock, whileHeld));
    await writer.held;
    await inJob('w4', file, () => withReader(lock, () => Promise.resolve()));
    await writer.done;
    expect(endedWaits(file).map((w) => w.wait)).toEqual([lock.base]);
    expect(endedWaits(file)[0]?.ms).toBeGreaterThanOrEqual(250);
    // a writer waits for the readers
    const second = join(dir, 'w5.spans.jsonl');
    const reader = holdFor(1200, (whileHeld) => withReader(lock, whileHeld));
    await reader.held;
    await inJob('w5', second, () => withWriter(lock, () => Promise.resolve()));
    await reader.done;
    expect(endedWaits(second).map((w) => w.wait)).toEqual([lock.base]);
    expect(endedWaits(second)[0]?.ms).toBeGreaterThanOrEqual(800);
    // a writer that waits at most the wait of the lock (withWriterWithin) records its wait too
    const third = join(dir, 'w6.spans.jsonl');
    const again = holdFor(1200, (whileHeld) => withReader(lock, whileHeld));
    await again.held;
    expect((await inJob('w6', third, () => withWriterWithin(lock, () => Promise.resolve(2)))).ran).toBe(true);
    await again.done;
    expect(endedWaits(third).map((w) => w.wait)).toEqual([lock.base]);
  });

  it('records a wait for a reader that joins the reader entry another reader of the process is still taking', async () => {
    const dir = tempDir();
    const lock = { base: join(dir, 'joined'), waitMs: 60_000 };
    const writer = holdFor(500, (whileHeld) => withWriter(lock, whileHeld));
    await writer.held;
    const first = join(dir, 'r1.spans.jsonl');
    const second = join(dir, 'r2.spans.jsonl');
    const taking = inJob('r1', first, () => withReader(lock, () => sleep(50)));
    await sleep(100);
    await inJob('r2', second, () => withReader(lock, () => Promise.resolve()));
    await Promise.all([taking, writer.done]);
    expect(endedWaits(first).map((w) => w.wait)).toEqual([lock.base]);
    expect(endedWaits(second).map((w) => w.wait)).toEqual([lock.base]);
    expect(endedWaits(second)[0]?.ms).toBeGreaterThanOrEqual(200);
  });

  it('records a wait on the slot folder when no slot is free, and on the ledger folder of a share, but not on its ledger lock', async () => {
    const dir = tempDir();
    const slots = join(dir, 'slots');
    const file = join(dir, 's1.spans.jsonl');
    const slot = holdFor(2500, (whileHeld) => withSlot(slots, 1, whileHeld));
    await slot.held;
    await inJob('s1', file, () => withSlot(slots, 1, () => Promise.resolve()));
    await slot.done;
    expect(endedWaits(file).map((w) => w.wait)).toEqual([slots]);
    const ledger = join(dir, 'ledger');
    mkdirSync(ledger);
    const shareFile = join(dir, 's2.spans.jsonl');
    const share = holdFor(700, (whileHeld) => withShare(ledger, 1, 1, whileHeld));
    await share.held;
    await inJob('s2', shareFile, () => withShare(ledger, 1, 1, () => Promise.resolve()));
    await share.done;
    expect(endedWaits(shareFile).map((w) => w.wait)).toEqual([ledger]);
    // a share that waits for its ledger lock waits on the ledger: the take of the lock is part of the take of the share
    const lockFile = join(dir, 's3.spans.jsonl');
    const ledgerLock = holdFor(700, (whileHeld) => withLock(join(ledger, 'lock'), whileHeld));
    await ledgerLock.held;
    await inJob('s3', lockFile, () => withShare(ledger, 1, 1, () => Promise.resolve()));
    await ledgerLock.done;
    expect(endedWaits(lockFile).map((w) => w.wait)).toEqual([ledger]);
    expect(endedWaits(lockFile)[0]?.ms).toBeGreaterThanOrEqual(400);
  });
});

describe('child jobs', () => {
  it('records the job and step span that started a job, and the agent job of a job started from inside an agent', async () => {
    const ws = makeWorkspace();
    const argv = ['job', 'status', 'nojob'];
    const base = { argv, cwd: ws.root, command: 'job status', game: null, timeLimitMs: 60_000, env: ws.env };
    let stepId: string | null = null;
    const child = await inJob('parentjob', join(ws.root, 'parentjob.spans.jsonl'), () => span('start child', () => {
      stepId = spanContext()?.span ?? null;
      return startJob({ ...base, agentJob: null });
    }));
    const fromAgent = await startJob({ ...base, agentJob: 'agentjob' });
    const alone = await startJob({ ...base, agentJob: null });
    for (const id of [child, fromAgent, alone]) await waitJob(id, 30_000, ws.env);
    expect(await readJob(child, ws.env)).toMatchObject({ parentJob: 'parentjob', parentSpan: stepId });
    expect(await readJob(fromAgent, ws.env)).toMatchObject({ parentJob: 'agentjob', parentSpan: null });
    expect(await readJob(alone, ws.env)).toMatchObject({ parentJob: null, parentSpan: null });
  });
});
