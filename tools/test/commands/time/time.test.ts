// `ogw time` (ogw.md `## time`): the tree of a job or run, its critical path, self times, waits and flags.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { commands } from '../../../src/commands/index.ts';
import type { CommandDef } from '../../../src/lib/command.ts';
import { readJob, waitJob, type JobRecord } from '../../../src/lib/jobs.ts';
import { withLock, withLockWithin } from '../../../src/lib/lock.ts';
import { span, type SpanLine } from '../../../src/lib/spans.ts';
import { makeGame, ogw } from '../../helpers/workspace.ts';
import { jobWorkspace, writeJob } from '../job/helpers.ts';

const T = 1_800_000_000_000;
const S = 1000;

type Ws = ReturnType<typeof jobWorkspace>;

/** A job that ended `done`: from `T + start` s to `T + end` s. */
function job(ws: Ws, id: string, start: number, end: number, fields: Partial<JobRecord> = {}): void {
  writeJob(ws.jobs, { id, startedAt: T + start * S, endedAt: T + end * S, status: 'done', exitCode: 0, ...fields });
}

/** A step span line `[id, name, parent, start s, end s or null]` or a wait line `[id, {wait}, parent, start s, end s]`. */
type Row = [string, string | { wait: string }, string | null, number, number | null, true?];

/** Writes the spans file of job `id`: the start line of each row, then the end lines of those that ended. */
function spans(ws: Ws, id: string, rows: readonly Row[]): void {
  const lines: SpanLine[] = [];
  const of = ([sid, what, parent, start]: Row, end: number | null): SpanLine =>
    typeof what === 'string' ? { id: sid, name: what, parent, start: T + start * S, end } : { id: sid, wait: what.wait, parent, start: T + start * S, end };
  for (const row of rows) lines.push(of(row, null));
  for (const row of rows) {
    if (row[4] === null) continue;
    const line = of(row, T + row[4] * S);
    lines.push(row[5] === true && 'name' in line ? { ...line, failed: true } : line);
  }
  writeFileSync(join(ws.jobs, `${id}.spans.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

interface Data {
  wallMs: number;
  criticalPath: { key: string; depth: number; ms: number }[];
  selfTime: { key: string; ms: number }[];
  waits: { on: string; ms: number; count: number }[];
  flags: Record<string, unknown>[];
  root: { key: string; children: { key: string }[] };
}

async function timeOf(ws: Ws, args: string[]): Promise<Data> {
  const run = await ogw(ws, ['time', ...args, '--json']);
  expect(run.stderr).toBe('');
  expect(run.code).toBe(0);
  return JSON.parse(run.stdout) as Data;
}

/** The flags of `kind` as `[job or key, ...]`. */
function flagged(data: Data, kind: string): string[] {
  return data.flags.filter((f) => f.flag === kind).map((f) => String(kind === 'outlier' ? f.key : f.job) + (kind === 'wait' ? ` ${String(f.on)}` : ''));
}

/** A job whose steps cover its wall time and that waits for nothing: no flag fires on it. */
function quietJob(ws: Ws, id: string, start: number, fields: Partial<JobRecord> = {}): void {
  job(ws, id, start, start + 100, fields);
  spans(ws, id, [
    ['a', 'prepare', null, start, start + 40],
    ['b', 'run', null, start + 40, start + 100],
  ]);
}

describe('ogw time', () => {
  it('finds the critical path of a known span tree, through the job a step started', async () => {
    const ws = jobWorkspace();
    job(ws, 'p1', 0, 100);
    spans(ws, 'p1', [
      ['s1', 'setup', null, 0, 10],
      ['s2', 'work', null, 10, 90],
      ['s3', 'part a', 's2', 10, 50],
      ['s4', 'part b', 's2', 10, 80],
      ['s5', 'report', null, 90, 98],
    ]);
    job(ws, 'c1', 20, 85, { command: 'agent', meta: { role: 'judge' }, parentJob: 'p1', parentSpan: 's2' });
    spans(ws, 'c1', [['x', 'c step', null, 30, 84]]);
    // a job of p1 that ended after it did not decide its end
    job(ws, 'c2', 95, 120, { parentJob: 'p1', parentSpan: null });
    const data = await timeOf(ws, ['p1']);
    expect(data.wallMs).toBe(100 * S);
    expect(data.criticalPath.map((e) => [e.key, e.depth])).toEqual([
      ['p1', 0],
      ['p1/s1', 1],
      ['p1/s2', 1],
      ['c1', 2],
      ['c1/x', 3],
      ['p1/s5', 1],
    ]);
    expect(data.root.children.map((c) => c.key)).toEqual(['p1/s1', 'p1/s2', 'p1/s5', 'c2']);
    // p1: 100 s less setup, work, report and c2 (95..100); c1: 65 s less its step of 54 s
    expect(data.selfTime.slice(0, 3)).toEqual([
      { key: 'p1/s4', name: 'part b', ms: 70 * S },
      { key: 'c1/x', name: 'c step', ms: 54 * S },
      { key: 'p1/s3', name: 'part a', ms: 40 * S },
    ]);
    const text = await ogw(ws, ['time', 'p1']);
    expect(text.stdout.split('\n').slice(0, 9)).toEqual([
      `ogw check (p1): wall time 1m 40s, ${new Date(T).toISOString()} to ${new Date(T + 100 * S).toISOString()}`,
      '',
      'critical path:',
      '  1m 40s 100.0% ogw check (p1)',
      '    10.0s 10.0% setup (p1/s1)',
      '    1m 20s 80.0% work (p1/s2)',
      '      1m 05s 65.0% ogw agent judge (c1)',
      '        54.0s 54.0% c step (c1/x)',
      '    8.0s 8.0% report (p1/s5)',
    ]);
  });

  it('ends a step span and a wait without an end line at the end of their job, as a killed job left them', async () => {
    const ws = jobWorkspace();
    job(ws, 'k1', 0, 60, { status: 'failed', exitCode: null });
    spans(ws, 'k1', [
      ['a', 'done step', null, 0, 10],
      ['b', 'hung step', null, 10, null],
      ['w', { wait: '/locks/gate' }, 'b', 20, null],
    ]);
    const data = await timeOf(ws, ['k1']);
    expect(data.criticalPath.map((e) => [e.key, e.ms])).toEqual([
      ['k1', 60 * S],
      ['k1/a', 10 * S],
      ['k1/b', 50 * S],
    ]);
    expect(data.waits).toEqual([{ on: '/locks/gate', ms: 40 * S, count: 1 }]);
    expect((await ogw(ws, ['time', 'k1'])).stdout).toContain('50.0s 83.3% hung step (k1/b, running)');
  });

  it('flags wait when the waits of one job on one path reach time.waitShare of its wall time, each job on its own', async () => {
    const ws = jobWorkspace();
    job(ws, 'w1', 0, 100);
    spans(ws, 'w1', [
      ['s', 'step', null, 0, 100],
      ['w1', { wait: '/locks/a' }, 's', 0, 15],
      ['w2', { wait: '/locks/a' }, null, 40, 50],
      ['w3', { wait: '/locks/b' }, 's', 60, 84.9],
    ]);
    // the waits of the job it started are its own: 40 of its 50 s
    job(ws, 'w9', 10, 60, { parentJob: 'w1', parentSpan: 's' });
    spans(ws, 'w9', [
      ['s', 'inner', null, 10, 60],
      ['w', { wait: '/locks/a' }, 's', 10, 50],
    ]);
    const data = await timeOf(ws, ['w1']);
    // /locks/a: 15 + 10 = 25 s of 100 s is time.waitShare (0.25); /locks/b: 24.9 s is less
    expect(flagged(data, 'wait')).toEqual(['w1 /locks/a', 'w9 /locks/a']);
    expect(data.waits).toEqual([
      { on: '/locks/a', ms: 65 * S, count: 3 },
      { on: '/locks/b', ms: 24.9 * S, count: 1 },
    ]);
    const text = (await ogw(ws, ['time', 'w1'])).stdout;
    expect(text).toContain('wait: ogw check (w1) waited 25.0s on /locks/a, 25.0% of its wall time 1m 40s (time.waitShare 0.25)');
  });

  it('flags idle when a job with a step span spends time.idleShare of its wall time in no step, started job or job span wait', async () => {
    const ws = jobWorkspace();
    job(ws, 'i1', 0, 100);
    spans(ws, 'i1', [
      ['a', 'first', null, 0, 30],
      ['w', { wait: '/locks/x' }, null, 30, 40],
      ['b', 'second', null, 50, 70],
    ]);
    // a job it started covers 70..80: idle is 40..50 and 80..100, 30 s
    job(ws, 'i2', 70, 80, { parentJob: 'i1', parentSpan: null });
    job(ws, 'i3', 0, 100);
    spans(ws, 'i3', [
      ['a', 'first', null, 0, 30],
      ['b', 'second', null, 50, 80.1],
    ]);
    // no step span: its steps are not recorded, so it is not judged; nor with `job start` alone
    job(ws, 'i4', 0, 100);
    job(ws, 'i6', 0, 100);
    spans(ws, 'i6', [['s', 'job start', null, 0, 1]]);
    expect(flagged(await timeOf(ws, ['i1']), 'idle')).toEqual(['i1']);
    const quietish = await timeOf(ws, ['i3']);
    // i3: 100 - 30 - 30.1 = 39.9 s idle is flagged; at 0.4 it would not be
    expect(flagged(quietish, 'idle')).toEqual(['i3']);
    expect(flagged(await timeOf(ws, ['i4']), 'idle')).toEqual([]);
    expect(flagged(await timeOf(ws, ['i6']), 'idle')).toEqual([]);
    expect((await ogw(ws, ['time', 'i1'])).stdout).toContain('idle: ogw check (i1) spent 30.0s in no step span, started job or wait, 30.0% of its wall time 1m 40s (time.idleShare 0.2)');
  });

  it('does not flag idle below time.idleShare', async () => {
    const ws = jobWorkspace({ time: { waitShare: 0.25, idleShare: 0.4, outlierRatio: 3, history: 20 } });
    job(ws, 'i3', 0, 100);
    spans(ws, 'i3', [
      ['a', 'first', null, 0, 30],
      ['b', 'second', null, 50, 80.1],
    ]);
    job(ws, 'i5', 0, 100);
    spans(ws, 'i5', [
      ['a', 'first', null, 0, 30],
      ['b', 'second', null, 50, 80],
    ]);
    expect(flagged(await timeOf(ws, ['i3']), 'idle')).toEqual([]);
    // exactly time.idleShare is flagged
    expect(flagged(await timeOf(ws, ['i5']), 'idle')).toEqual(['i5']);
  });

  it('flags outlier when a span lasts more than time.outlierRatio times the median of its last earlier spans of the name and game', async () => {
    const ws = jobWorkspace();
    // five earlier checks of game g that took 10 s, each with a step of 5 s
    for (let n = 0; n < 5; n += 1) {
      job(ws, `h${String(n)}`, n * 20, n * 20 + 10, { game: 'g' });
      spans(ws, `h${String(n)}`, [['s', 'build', null, n * 20, n * 20 + 5]]);
    }
    // failed earlier steps and jobs, steps and jobs of another game, and steps and jobs that end after the judged one
    // starts do not count: with them the medians would be far above 5 s and 10 s
    for (let n = 0; n < 6; n += 1) {
      job(ws, `hf${String(n)}`, 100, 200, { game: 'g', status: 'failed' });
      spans(ws, `hf${String(n)}`, [['s', 'build', null, 100, 190, true]]);
      job(ws, `ho${String(n)}`, 100, 200, { game: 'other' });
      spans(ws, `ho${String(n)}`, [['s', 'build', null, 100, 190]]);
      job(ws, `hl${String(n)}`, 250, 400, { game: 'g' });
      spans(ws, `hl${String(n)}`, [['s', 'build', null, 250, 390]]);
    }
    job(ws, 'j1', 300, 331, { game: 'g' });
    spans(ws, 'j1', [['s', 'build', null, 300, 315.1]]);
    job(ws, 'j2', 300, 330, { game: 'g' });
    spans(ws, 'j2', [['s', 'build', null, 300, 315]]);
    // 31 s > 3 x 10 s; its step 15.1 s > 3 x 5 s
    expect(flagged(await timeOf(ws, ['j1']), 'outlier')).toEqual(['j1', 'j1/s']);
    // exactly 3 times is not more than it
    expect(flagged(await timeOf(ws, ['j2']), 'outlier')).toEqual([]);
    const text = (await ogw(ws, ['time', 'j1'])).stdout;
    expect(text).toContain('outlier: build (j1/s) took 15.1s, more than 3 times the median 5.0s of its last 5 earlier spans (time.outlierRatio)');
  });

  it('judges outlier only with at least 5 earlier spans, and against the last time.history of them', async () => {
    const ws = jobWorkspace({ time: { waitShare: 0.25, idleShare: 0.2, outlierRatio: 3, history: 5 } });
    for (let n = 0; n < 4; n += 1) job(ws, `a${String(n)}`, n * 20, n * 20 + 10, { game: 'g', command: 'deploy' });
    job(ws, 'few', 100, 200, { game: 'g', command: 'deploy' });
    expect(flagged(await timeOf(ws, ['few']), 'outlier')).toEqual([]);
    // five old spans of 100 s, then five of 10 s: the last 5 have the median 10 s
    for (let n = 0; n < 5; n += 1) job(ws, `o${String(n)}`, 1000 + n * 200, 1000 + n * 200 + 100, { game: 'g', command: 'core try' });
    for (let n = 0; n < 5; n += 1) job(ws, `r${String(n)}`, 2000 + n * 20, 2000 + n * 20 + 10, { game: 'g', command: 'core try' });
    job(ws, 'late', 3000, 3040, { game: 'g', command: 'core try' });
    expect(flagged(await timeOf(ws, ['late']), 'outlier')).toEqual(['late']);
    // the median of 10, 10, 10, 10 and 100 s is 10 s (the mean, 28 s, would not flag 40 s)
    [10, 10, 100, 10, 10].forEach((ms, n) => {
      job(ws, `v${String(n)}`, 4000 + n * 200, 4000 + n * 200 + ms, { game: 'g', command: 'video' });
    });
    job(ws, 'vid', 5000, 5040, { game: 'g', command: 'video' });
    expect(flagged(await timeOf(ws, ['vid']), 'outlier')).toEqual(['vid']);
  });

  it('flags nothing on a quiet job', async () => {
    const ws = jobWorkspace();
    for (let n = 0; n < 6; n += 1) quietJob(ws, `q${String(n)}`, n * 200, { game: 'g' });
    const data = await timeOf(ws, ['q5']);
    expect(data.flags).toEqual([]);
    expect((await ogw(ws, ['time', 'q5'])).stdout).toMatch(/waits:\n {2}none\n\nflags:\n {2}none\n$/);
  });

  it('reports the jobs of a run or of one iteration of it under a run span', async () => {
    const ws = jobWorkspace();
    const root = makeGame(ws, 'g');
    const run = { name: 'create-1', kind: 'loop', command: 'create', env: null, version: null, platforms: [], bundleFor: null, branch: 'loop/create-1', baseCommit: 'x', referenceCommit: null, startedAt: T, closedAt: T + 1000 * S, iteration: 2, data: {} };
    writeFileSync(join(root, '.git', 'ogw-runs.json'), JSON.stringify({ runs: [run] }));
    const agent = (iteration: number): Partial<JobRecord> => ({ game: 'g', command: 'agent', meta: { role: 'content', run: 'create-1', iteration } });
    job(ws, 'a1', 10, 90, agent(1));
    job(ws, 'k1', 100, 200, { game: 'g' });
    job(ws, 'a2', 500, 550, agent(2));
    job(ws, 'k2', 600, 700, { game: 'g' });
    job(ws, 'k3', 610, 650, { game: 'g', parentJob: 'k2', parentSpan: null });
    // before the run and of another game
    job(ws, 'z1', -50, -10, { game: 'g' });
    job(ws, 'z2', 100, 120, { game: 'other' });
    // an agent job of a run of the same name in another game does not end iteration 1 of g
    job(ws, 'z3', 300, 310, { game: 'other', command: 'agent', meta: { role: 'content', run: 'create-1', iteration: 2 } });
    const one = await timeOf(ws, ['g', '--run', 'create-1', '--iteration', '1']);
    expect(one.root.key).toBe('run create-1');
    expect(one.root.children.map((c) => c.key)).toEqual(['a1', 'k1']);
    expect(one.wallMs).toBe(490 * S);
    // 490 s less a1 (80 s) and k1 (100 s)
    expect(one.selfTime[0]).toEqual({ key: 'run create-1', name: 'run create-1 iteration 1', ms: 310 * S });
    const two = await timeOf(ws, ['g', '--run', 'create-1', '--iteration', '2']);
    expect(two.root.children.map((c) => c.key)).toEqual(['a2', 'k2']);
    expect(two.criticalPath.map((e) => e.key)).toEqual(['run create-1', 'a2', 'k2', 'k3']);
    const all = await timeOf(ws, ['g', '--run', 'create-1']);
    expect(all.root.children.map((c) => c.key)).toEqual(['a1', 'k1', 'a2', 'k2']);
    expect(all.wallMs).toBe(1000 * S);
    expect((await ogw(ws, ['time', 'g', '--run', 'create-1', '--iteration', '3'])).stderr).toBe('iteration 3 of run create-1 has no ogw agent job\n');
    expect((await ogw(ws, ['time', 'g', '--run', 'nope'])).stderr).toBe('no run nope in game g\n');
  });

  it('records the steps and waits of a command that runs as a job, which ogw time then reports', async () => {
    const ws = jobWorkspace();
    const lock = join(ws.root, 'busy.lock');
    const steps: CommandDef = {
      name: ['steps'],
      usage: 'ogw steps',
      run: async () => {
        await span('first', () => sleep(30));
        await span('second', () => withLock(lock, () => sleep(10)));
        return { text: 'ok' };
      },
    };
    writeJob(ws.jobs, { id: 'e1', startedAt: Date.now() });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      void withLock(lock, () => new Promise<void>((done) => {
        release = done;
        resolve();
      }));
    });
    await held;
    setTimeout(() => {
      release();
    }, 300);
    const run = await ogw(ws, ['steps'], { commands: [...commands, steps], env: { ...ws.env, OGW_JOB_ID: 'e1' } });
    expect(run).toMatchObject({ code: 0, stdout: 'ok\n' });
    writeJob(ws.jobs, { id: 'e1', startedAt: Date.now() - 2000, endedAt: Date.now(), status: 'done', exitCode: 0 });
    const data = await timeOf(ws, ['e1']);
    const root = data.root as unknown as { children: { name: string; waits: { on: string; ms: number }[] }[] };
    expect(root.children.map((c) => c.name)).toEqual(['first', 'second']);
    expect(root.children[1]?.waits.map((w) => w.on)).toEqual([lock]);
    expect(root.children[1]?.waits[0]?.ms).toBeGreaterThanOrEqual(150);
  });

  it('records the steps of a process of no job in the step span that its environment names, with the jobs it starts, and passes that span to no process it starts', async () => {
    const ws = jobWorkspace();
    const seen: (string | undefined)[][] = [];
    const side: CommandDef = {
      name: ['side'],
      usage: 'ogw side',
      background: { timeLimitMs: () => 60_000 },
      run: async (ctx) => {
        await span('inside', () => sleep(20));
        seen.push([ctx.env.OGW_PARENT_JOB, ctx.env.OGW_PARENT_SPAN]);
        return { text: 'ok' };
      },
    };
    const started = Date.now();
    writeJob(ws.jobs, { id: 'r1', startedAt: started });
    // the step span of job r1 that starts the side command, as the process of r1 writes it
    const s1: SpanLine = { id: 's1', name: 'regress check', parent: null, start: started, end: null };
    writeFileSync(join(ws.jobs, 'r1.spans.jsonl'), `${JSON.stringify(s1)}\n`);
    const parent = { OGW_PARENT_JOB: 'r1', OGW_PARENT_SPAN: 's1' };
    expect(await ogw(ws, ['side'], { commands: [...commands, side], env: { ...ws.env, ...parent } })).toMatchObject({ code: 0, stdout: 'ok\n' });
    expect(seen).toEqual([[undefined, undefined]]);
    const background = await ogw(ws, ['side', '--background', '--json'], { commands: [...commands, side], env: { ...ws.env, ...parent } });
    expect(background.code).toBe(0);
    const child = (JSON.parse(background.stdout) as { job: string }).job;
    await waitJob(child, 30_000, ws.env);
    expect(await readJob(child, ws.env)).toMatchObject({ parentJob: 'r1', parentSpan: 's1' });
    writeFileSync(join(ws.jobs, 'r1.spans.jsonl'), `${JSON.stringify({ ...s1, end: Date.now() })}\n`, { flag: 'a' });
    writeJob(ws.jobs, { id: 'r1', startedAt: started, endedAt: Date.now(), status: 'done', exitCode: 0 });
    const data = await timeOf(ws, ['r1']);
    const root = data.root as unknown as { children: { key: string; name: string; children: { kind: string; name: string; key: string }[] }[] };
    expect(root.children.map((c) => c.key)).toEqual(['r1/s1']);
    expect(root.children[0]?.children.map((c) => `${c.kind} ${c.name}`)).toEqual(['step inside', `job ogw side`]);
  });

  it('fails a job command whose spans file cannot be written when it ends, after letting go of the lock it waited for', async () => {
    const ws = jobWorkspace();
    const lock = join(ws.root, 'held.lock');
    let ran = false;
    const steps: CommandDef = {
      name: ['steps'],
      usage: 'ogw steps',
      run: async () => {
        await span('step', () => withLock(lock, () => sleep(10)));
        ran = true;
        return { text: 'ok' };
      },
    };
    writeJob(ws.jobs, { id: 'f1', startedAt: Date.now() });
    // a folder where the spans file goes: no line can be written
    mkdirSync(join(ws.jobs, 'f1.spans.jsonl'));
    let release: () => void = () => undefined;
    await new Promise<void>((resolve) => {
      void withLock(lock, () => new Promise<void>((done) => {
        release = done;
        resolve();
      }));
    });
    setTimeout(() => {
      release();
    }, 300);
    const run = await ogw(ws, ['steps'], { commands: [...commands, steps], env: { ...ws.env, OGW_JOB_ID: 'f1' } });
    expect(ran).toBe(true);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/^cannot write the spans file .*f1\.spans\.jsonl: EISDIR/);
    // the lock that the wait was written for is free again
    expect(existsSync(lock)).toBe(false);
    expect((await withLockWithin(lock, () => Promise.resolve(1), 0)).ran).toBe(true);
  });

  it('refuses a bad command line and fails on a spans file it cannot read', async () => {
    const ws = jobWorkspace();
    expect((await ogw(ws, ['time'])).stderr).toBe('usage: ogw time <job id> | ogw time <game> --run <run> [--iteration <n>]\n');
    expect((await ogw(ws, ['time', 'x1', '--iteration', '1'])).stderr).toBe('--iteration needs --run; usage: ogw time <job id> | ogw time <game> --run <run> [--iteration <n>]\n');
    expect((await ogw(ws, ['time', 'g', '--run', 'r', '--iteration', '0'])).stderr).toBe('invalid --iteration: 0\n');
    expect((await ogw(ws, ['time', 'none1'])).stderr).toBe('job not found: none1\n');
    job(ws, 'b1', 0, 10);
    writeFileSync(join(ws.jobs, 'b1.spans.jsonl'), '{"id":"a","name":"x","parent":null,"start":1,"end":null}\nnot json\n');
    expect((await ogw(ws, ['time', 'b1'])).stderr).toMatch(/b1\.spans\.jsonl:2: not a span line/);
    job(ws, 'b2', 0, 10);
    spans(ws, 'b2', [['a', 'x', 'missing', 0, 5]]);
    expect((await ogw(ws, ['time', 'b2'])).stderr).toBe('job b2: span a is in span missing, which its spans file does not hold\n');
    job(ws, 'b3', 0, 10);
    spans(ws, 'b3', [['a', 'x', null, 0, 5]]);
    job(ws, 'b4', 1, 4, { parentJob: 'b3', parentSpan: 'gone' });
    expect((await ogw(ws, ['time', 'b3'])).stderr).toBe('job b3: job b4 is in span gone, which its spans file does not hold\n');
  });
});
