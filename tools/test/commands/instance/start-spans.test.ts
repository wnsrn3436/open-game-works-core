// The steps and waits that `ogw instance start` records when it runs in a job (ogw.md `## time`): the slot reservation
// as a wait on the instance slots, the steps of the start, and the steps of the boot that the supervisor writes in the
// `boot` span of the start.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { instancesDir, listRecords } from '../../../src/commands/instance/lib/records.ts';
import { hostBootId } from '../../../src/lib/jobs.ts';
import type { SpanLine } from '../../../src/lib/spans.ts';
import { ogw } from '../../helpers/workspace.ts';
import { writeJob } from '../job/helpers.ts';
import { setupRunner, startFor, stopAll, type Runner } from './runner.ts';

vi.mock('../../../src/commands/generate/api.ts', async () => (await import('./mocks/apis.ts')).generate);
vi.mock('../../../src/commands/data/api.ts', async () => (await import('./mocks/apis.ts')).data);
vi.mock('../../../src/commands/core/api.ts', async () => (await import('./mocks/apis.ts')).core);
vi.mock('../../../src/commands/env/api.ts', async () => (await import('./mocks/apis.ts')).env);
vi.mock('../../../src/commands/instance/lib/spawn.ts', () => import('./mocks/spawn.ts'));
vi.mock('../../../src/commands/instance/lib/launch.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/commands/instance/lib/launch.ts')>();
  return { ...real, ...(await import('./mocks/apis.ts')).launchOverrides(real) };
});

let runner: Runner | null = null;

afterEach(async () => {
  if (runner) await stopAll(runner);
  runner = null;
});

interface Tree {
  name: string;
  waits: { on: string; ms: number }[];
  children: Tree[];
}

/** The names of a tree, each with the names below it. */
function names(tree: Tree): unknown {
  return tree.children.length === 0 ? tree.name : { [tree.name]: tree.children.map(names) };
}

describe('ogw instance start in a job', () => {
  it('records its slot wait, its steps, and the boot steps of its supervisor in its boot span', async () => {
    runner = setupRunner({ harness: { maxConcurrentInstances: 2, instanceWaitTimeoutMs: 20_000 } });
    const r = runner;
    const jobs = join(r.ws.root, 'jobs');
    mkdirSync(jobs);
    r.ws.env.OGW_JOBS_DIR = jobs;
    const a = await startFor(r);
    await startFor(r, ['--platform', 'ios']);
    writeJob(jobs, { id: 'sj1', command: 'instance start', startedAt: Date.now(), supervisorPid: process.pid, bootId: hostBootId() });
    setTimeout(() => {
      void ogw(r.ws, ['instance', 'stop', a]);
    }, 400);
    const started = await ogw(r.ws, ['instance', 'start', 'g'], { env: { ...r.ws.env, OGW_JOB_ID: 'sj1' } });
    expect(started.code).toBe(0);
    const lines = readFileSync(join(jobs, 'sj1.spans.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as SpanLine);
    const slotWait = lines.find((l) => 'wait' in l && l.end !== null);
    expect(slotWait).toMatchObject({ wait: join(await instancesDir(r.ws.env), 'slots') });
    writeJob(jobs, { id: 'sj1', command: 'instance start', startedAt: Date.now() - 60_000, endedAt: Date.now(), status: 'done', exitCode: 0 });
    const time = await ogw(r.ws, ['time', 'sj1', '--json']);
    const root = (JSON.parse(time.stdout) as { root: Tree }).root;
    const start = root.children[0] as Tree;
    expect(start.waits.map((w) => w.on)).toEqual([join(await instancesDir(r.ws.env), 'slots')]);
    expect(start.waits[0]?.ms).toBeGreaterThanOrEqual(300);
    expect(names(start)).toEqual({ 'instance start': ['worktree', 'plan', 'import', { boot: ['database', 'server', 'client main', 'bots'] }] });
  });

  it('leaves a spans line its supervisor cannot write to the command of the job: the instance starts, the command fails', async () => {
    runner = setupRunner();
    const r = runner;
    const jobs = join(r.ws.root, 'jobs');
    mkdirSync(jobs);
    r.ws.env.OGW_JOBS_DIR = jobs;
    writeJob(jobs, { id: 'sj2', command: 'instance start', startedAt: Date.now(), supervisorPid: process.pid, bootId: hostBootId() });
    // a folder where the spans file goes: no line can be written
    mkdirSync(join(jobs, 'sj2.spans.jsonl'));
    const started = await ogw(r.ws, ['instance', 'start', 'g'], { env: { ...r.ws.env, OGW_JOB_ID: 'sj2' } });
    expect(started.code).toBe(1);
    expect(started.stderr).toMatch(/cannot write the spans file .*sj2\.spans\.jsonl/);
    const records = await listRecords(r.ws.env);
    expect(records.map((record) => [record.status, record.failure])).toEqual([['running', null]]);
  });
});
