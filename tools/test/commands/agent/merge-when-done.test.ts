import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listJobs, readJob } from '../../../src/lib/jobs.ts';
import { ogw, commitAll, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeAgentCli } from './helpers.ts';

const PASSED = { command: 'ogw core test server', startedAt: 1, exitCode: 0, summary: { tests: 2, passed: 2 } };

function coreSpec(ws: TestWorkspace, modules: string[]): void {
  mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
  for (const name of modules) writeFileSync(join(ws.coreImpl, 'core-spec', `${name}.json`), JSON.stringify({ name, dependencies: [] }));
  commitAll(ws.coreImpl, 'spec');
}

/** The fake agent CLI of every core job of these tests: each job reads its options from `opts-<module>.json`. */
const AGENT_SCRIPT = [
      "const o = JSON.parse(fs.readFileSync(input.replace(/in-([^/]+)\\.md$/, 'opts-$1.json'), 'utf8'));",
      "while (o.gate !== '' && !fs.existsSync(o.gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);",
      'if (o.fail) process.exit(1);',
      "fs.mkdirSync('server', { recursive: true }); fs.writeFileSync('server/' + o.module + '.ts', 'export {};\\n');",
      "execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', o.module, '--no-verify']);",
      "fs.writeFileSync(output, 'r'); fs.writeFileSync(output.replace(/\\.md$/, '-runs.json'), JSON.stringify({ runs: o.runs }));",
].join('\n');

/**
 * Starts a core agent job for `module` in the background. Its agent waits for file `gate` in the workspace root, then
 * commits `server/<module>.ts`, writes the report and a run log with `runs`; with `fail` it exits 1 without a report.
 * The fake agent CLI is one script for every job: each job reads its options from `opts-<module>.json`.
 */
async function startCoreJob(ws: TestWorkspace, module: string, options: { runs?: unknown[]; gate?: string; fail?: boolean } = {}): Promise<string> {
  writeFileSync(join(ws.root, `in-${module}.md`), 'command: create server core\n');
  const gate = options.gate === undefined ? '' : join(ws.root, options.gate);
  writeFileSync(join(ws.root, `opts-${module}.json`), JSON.stringify({ module, gate, fail: options.fail === true, runs: options.runs ?? [PASSED] }));
  const fake = fakeAgentCli(ws, AGENT_SCRIPT);
  const started = await ogw(ws, ['agent', 'core', '--module', module, '--input', join(ws.root, `in-${module}.md`), '--background'], { env: fake.env });
  expect(started.code).toBe(0);
  return started.stdout.trim();
}

async function waitJobDone(ws: TestWorkspace, id: string): Promise<{ code: number; stdout: string }> {
  return ogw(ws, ['job', 'wait', id, '--timeout', '60000']);
}

/** Ids of the jobs whose command is `command`. */
async function jobsOf(ws: TestWorkspace, command: string): Promise<string[]> {
  return (await listJobs(ws.env)).filter((job) => job.command === command).map((job) => job.id);
}

describe('ogw agent merge --when-done', () => {
  it('waits for every job, merges them, then starts the --then jobs in the order given', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, ['routing', 'storage']);
    const routing = await startCoreJob(ws, 'routing', { gate: 'gate' });
    const storage = await startCoreJob(ws, 'storage', { gate: 'gate' });
    const started = await ogw(ws, ['agent', 'merge', routing, storage, '--when-done', '--then', 'check nogame', '--then', 'loop sync nogame --wait', '--background']);
    expect(started.code).toBe(0);
    const merge = started.stdout.trim();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // the agents wait for the gate: nothing is merged yet and no --then job started
    expect((await readJob(merge, ws.env)).status).toBe('running');
    expect((await readJob(routing, ws.env)).meta.merged).toBe(false);
    expect(await jobsOf(ws, 'check')).toEqual([]);
    writeFileSync(join(ws.root, 'gate'), '');
    const waited = await waitJobDone(ws, merge);
    expect(waited.code).toBe(0);
    const lines = waited.stdout.trim().split('\n');
    expect(lines.slice(0, 2).sort()).toEqual([`merged ${routing}`, `merged ${storage}`].sort());
    const [check = ''] = await jobsOf(ws, 'check');
    const [sync = ''] = await jobsOf(ws, 'loop sync');
    expect(lines.slice(2)).toEqual([`then ${check}: check nogame`, `then ${sync}: loop sync nogame --wait`]);
    const checkJob = await readJob(check, ws.env);
    const syncJob = await readJob(sync, ws.env);
    expect(checkJob.argv).toEqual(['check', 'nogame']);
    expect(syncJob.argv).toEqual(['loop', 'sync', 'nogame', '--wait']);
    expect(checkJob.startedAt).toBeLessThanOrEqual(syncJob.startedAt);
    expect(sh(ws.coreImpl, 'git', ['log', '--format=%s', '-2']).trim().split('\n').sort()).toEqual([`ogw agent merge ${routing}`, `ogw agent merge ${storage}`].sort());
  });

  it('starts an ogw agent job as a --then command, the agent starting its job itself', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, ['routing', 'storage']);
    const routing = await startCoreJob(ws, 'routing');
    writeFileSync(join(ws.root, 'in-storage.md'), 'command: create server core\n');
    writeFileSync(join(ws.root, 'opts-storage.json'), JSON.stringify({ module: 'storage', gate: '', fail: false, runs: [PASSED] }));
    const fake = fakeAgentCli(ws, AGENT_SCRIPT);
    const then = `agent core --module storage --input ${join(ws.root, 'in-storage.md')}`;
    const started = await ogw(ws, ['agent', 'merge', routing, '--when-done', '--then', then, '--background'], { env: fake.env });
    expect(started.code).toBe(0);
    const waited = await waitJobDone(ws, started.stdout.trim());
    expect(waited.code).toBe(0);
    const agentJob = /^then (\w+): /m.exec(waited.stdout)?.[1] ?? '';
    const job = await readJob(agentJob, ws.env);
    expect(job.command).toBe('agent');
    expect((job.meta as { modules: string[] }).modules).toEqual(['storage']);
  });

  it('merges nothing and starts no --then job when a job did not end done', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, ['routing', 'storage']);
    const routing = await startCoreJob(ws, 'routing');
    const storage = await startCoreJob(ws, 'storage', { fail: true });
    const started = await ogw(ws, ['agent', 'merge', routing, storage, '--when-done', '--then', 'check nogame', '--background']);
    expect(started.code).toBe(0);
    const waited = await waitJobDone(ws, started.stdout.trim());
    expect(waited).toMatchObject({ code: 1, stdout: `not done ${storage}: failed\n` });
    expect((await readJob(routing, ws.env)).meta.merged).toBe(false);
    expect(sh(ws.coreImpl, 'git', ['log', '--format=%s', '-1']).trim()).toBe('spec');
    expect(await jobsOf(ws, 'check')).toEqual([]);
  });

  it('starts no --then job when a job was not merged', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, ['routing']);
    const routing = await startCoreJob(ws, 'routing', { runs: [] });
    const started = await ogw(ws, ['agent', 'merge', routing, '--when-done', '--then', 'check nogame', '--background']);
    const waited = await waitJobDone(ws, started.stdout.trim());
    expect(waited.code).toBe(1);
    expect(waited.stdout).toContain(`not merged ${routing}: no core test:`);
    expect(waited.stdout).not.toContain('then ');
    expect(await jobsOf(ws, 'check')).toEqual([]);
  });

  it('reports the merge and the started --then jobs when a --then command fails to start, and starts no later one', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, ['routing']);
    const routing = await startCoreJob(ws, 'routing');
    const failing = 'agent content --input x.md';
    const started = await ogw(ws, ['agent', 'merge', routing, '--when-done', '--then', 'check nogame', '--then', failing, '--then', 'loop sync nogame --wait', '--background']);
    expect(started.code).toBe(0);
    const waited = await waitJobDone(ws, started.stdout.trim());
    expect(waited.code).toBe(1);
    const [check = ''] = await jobsOf(ws, 'check');
    expect(waited.stdout.trim().split('\n')).toEqual([
      `merged ${routing}`,
      `then ${check}: check nogame`,
      `then not started: ${failing}: --game is required for role content`,
    ]);
    expect(await jobsOf(ws, 'loop sync')).toEqual([]);
    expect((await readJob(routing, ws.env)).meta.merged).toBe(true);
  });

  it('refuses an id of a job that is not an ogw agent job before starting', async () => {
    const ws = makeWorkspace();
    const check = await ogw(ws, ['check', 'nogame', '--background']);
    expect(check.code).toBe(0);
    const id = check.stdout.trim();
    const run = await ogw(ws, ['agent', 'merge', id, '--when-done', '--background']);
    expect(run).toMatchObject({ code: 1, stderr: `not an ogw agent job: ${id}\n` });
    expect(await jobsOf(ws, 'agent merge')).toEqual([]);
  });

  it('refuses an empty --then, one with --background, an unknown command and one that takes no --background, before starting', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, ['routing']);
    const routing = await startCoreJob(ws, 'routing');
    await ogw(ws, ['agent', 'wait', routing, '--timeout', '60000']);
    const cases: [string, string][] = [
      ['', 'empty command'],
      ['  ', 'empty command'],
      ['check nogame --background', '--background is not taken'],
      ['nosuch command', 'no such command'],
      ['agent status x', 'agent status does not take --background'],
      ['check nogame --nosuch', 'unknown option --nosuch'],
      // the check `--background` makes before its job starts: a merge without --when-done
      [`agent merge ${routing}`, '--background needs --when-done'],
    ];
    for (const [then, error] of cases) {
      const run = await ogw(ws, ['agent', 'merge', routing, '--when-done', '--then', then, '--background']);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(`invalid --then ${JSON.stringify(then)}: `);
      expect(run.stderr).toContain(error);
    }
    const unknown = await ogw(ws, ['agent', 'merge', 'nojob1', '--when-done', '--background']);
    expect(unknown).toMatchObject({ code: 1, stderr: 'job not found: nojob1\n' });
    expect(await jobsOf(ws, 'agent merge')).toEqual([]);
    expect((await readJob(routing, ws.env)).meta.merged).toBe(false);
  });

  it('is a usage error with --then and no --when-done, and runs only with --background', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, ['routing']);
    const routing = await startCoreJob(ws, 'routing');
    await ogw(ws, ['agent', 'wait', routing, '--timeout', '60000']);
    for (const background of [[], ['--background']]) {
      const run = await ogw(ws, ['agent', 'merge', routing, '--then', 'check nogame', ...background]);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('--then needs --when-done; usage: ogw agent merge');
    }
    const plainBackground = await ogw(ws, ['agent', 'merge', routing, '--background']);
    expect(plainBackground).toMatchObject({ code: 1 });
    expect(plainBackground.stderr).toContain('--background needs --when-done');
    const foreground = await ogw(ws, ['agent', 'merge', routing, '--when-done']);
    expect(foreground).toMatchObject({ code: 1 });
    expect(foreground.stderr).toContain('--when-done runs only with --background');
    expect(await jobsOf(ws, 'agent merge')).toEqual([]);
    expect((await readJob(routing, ws.env)).meta.merged).toBe(false);
    // the plain merge is as before
    expect(await ogw(ws, ['agent', 'merge', routing])).toMatchObject({ code: 0, stdout: `merged ${routing}\n` });
  });
});
