import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listJobs, readJob } from '../../../src/lib/jobs.ts';
import { ogw, makeWorkspace, sh } from '../../helpers/workspace.ts';
import { fakeAgentCli, gameWithRun, runAgent, WRITE_OUTPUT } from './helpers.ts';

describe('ogw agent retry', () => {
  it('starts the same role and game with the input and the previous attempt, up to the content retry limit', async () => {
    const ws = makeWorkspace({ backgroundRetryLimit: 1 });
    const { root } = await gameWithRun(ws, { 'records/loops/r1/content-input-1.md': '## request\nnone\n' });
    const failing = fakeAgentCli(ws, "console.log('could not finish');");
    const input = join(root, 'records/loops/r1/content-input-1.md');
    const first = await runAgent(ws, ['content', '--game', 'g', '--input', input], failing.env, root);
    expect(first.waited.code).toBe(1);
    const retried = await ogw(ws, ['agent', 'retry', first.id, '--background'], { env: failing.env, cwd: root });
    expect(retried.code).toBe(0);
    const second = retried.stdout.trim();
    const retryInput = join(root, 'records/loops/r1/content-input-1-retry-1.md');
    const text = readFileSync(retryInput, 'utf8');
    expect(text.startsWith('## request\nnone\n\n## previous attempt\n\nnone\n\nfailed\nfailed: the agent left no result file\noutput: none\ncould not finish')).toBe(true);
    const job = await readJob(second, ws.env);
    expect(job.meta).toMatchObject({ role: 'content', game: 'g', input: retryInput, retryRoot: first.id, retryNumber: 1 });
    expect((await ogw(ws, ['agent', 'wait', second, '--timeout', '60000'])).code).toBe(1);
    expect(sh(root, 'git', ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    expect(sh(root, 'git', ['log', '--name-only', '--format=%s'])).toContain(`ogw agent retry ${first.id}: input\n\nrecords/loops/r1/content-input-1-retry-1.md`);
    const limited = await ogw(ws, ['agent', 'retry', second], { env: failing.env, cwd: root });
    expect(limited.code).toBe(1);
    expect(limited.stderr).toContain(`job ${second}: the work was retried 1 times (backgroundRetryLimit 1)`);
  });

  it('does not take the result file an earlier attempt left at the same path as the retry result', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'records/loops/r1/content-input-1.md': '## request\nnone\n' });
    const input = join(root, 'records/loops/r1/content-input-1.md');
    const output = join(root, 'records/loops/r1/content-1.md');
    const first = await runAgent(ws, ['content', '--game', 'g', '--input', input], fakeAgentCli(ws, `${WRITE_OUTPUT} process.exitCode = 3;`).env, root);
    expect(first.waited.stdout).toContain(`failed: agent CLI ended with code 3\noutput: ${output}`);
    const silent = fakeAgentCli(ws, 'process.exitCode = 0;');
    const second = (await ogw(ws, ['agent', 'retry', first.id, '--background'], { env: silent.env, cwd: root })).stdout.trim();
    const waited = await ogw(ws, ['agent', 'wait', second, '--timeout', '60000']);
    expect(waited.code).toBe(1);
    expect(waited.stdout).toContain('failed: the agent left no result file\noutput: none');
    expect((await ogw(ws, ['agent', 'status', second])).stdout).toBe('failed\n');
    expect(readFileSync(output, 'utf8')).toBe('result\n');
    const same = fakeAgentCli(ws, WRITE_OUTPUT);
    const third = await ogw(ws, ['agent', 'retry', second], { env: same.env, cwd: root });
    expect(third).toMatchObject({ code: 0, stdout: `${output}\n` });
  });

  it('runs a retry in the foreground and prints the result path', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'records/loops/r1/resource-requests/a.md': 'x' });
    const failing = fakeAgentCli(ws, 'process.exitCode = 2;');
    const first = await runAgent(ws, ['resource', '--game', 'g', '--input', join(root, 'records/loops/r1/resource-requests/a.md')], failing.env, root);
    const ok = fakeAgentCli(ws, WRITE_OUTPUT);
    const run = await ogw(ws, ['agent', 'retry', first.id], { env: ok.env, cwd: root });
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/records\/loops\/r1\/resource-requests\/a-result\.md\n$/);
    expect(readFileSync(join(root, 'records/loops/r1/resource-requests/a-retry-1.md'), 'utf8')).toContain('failed: agent CLI ended with code 2');
  });

  it('retries a translation job with the language and result file of the first input', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'records/loops/r1/translation-input-ko-5.md': 'ko\n' });
    const failing = fakeAgentCli(ws, 'process.exitCode = 1;');
    const first = await runAgent(ws, ['translation', '--game', 'g', '--input', join(root, 'records/loops/r1/translation-input-ko-5.md')], failing.env, root);
    expect(first.waited.code).toBe(1);
    const ok = fakeAgentCli(ws, WRITE_OUTPUT);
    const run = await ogw(ws, ['agent', 'retry', first.id, '--json'], { env: ok.env, cwd: root });
    expect(run.code).toBe(0);
    const output = (JSON.parse(run.stdout) as { output: string }).output;
    expect(output).toMatch(/\/records\/loops\/r1\/translation-ko-5\.md$/);
    const retried = (await listJobs(ws.env)).find((j) => j.meta.retryRoot === first.id);
    expect(retried?.meta).toMatchObject({ role: 'translation', language: 'ko', retryNumber: 1 });
  });

  it('retries a retry with the first input, commits each retry input, and applies the limit only to content', async () => {
    const ws = makeWorkspace({ backgroundRetryLimit: 1 });
    const { root } = await gameWithRun(ws, { 'records/loops/r1/resource-requests/a.md': '## keys\nhero\n' });
    const failing = fakeAgentCli(ws, "console.log('attempt failed');");
    const first = await runAgent(ws, ['resource', '--game', 'g', '--input', join(root, 'records/loops/r1/resource-requests/a.md')], failing.env, root);
    expect(first.waited.code).toBe(1);
    const one = await ogw(ws, ['agent', 'retry', first.id], { env: failing.env, cwd: root });
    expect(one.code).toBe(1);
    const second = (await listJobs(ws.env)).find((j) => j.meta.retryRoot === first.id)?.id as string;
    const two = await ogw(ws, ['agent', 'retry', second, '--background'], { env: failing.env, cwd: root });
    expect(two.code).toBe(0);
    await ogw(ws, ['agent', 'wait', two.stdout.trim(), '--timeout', '60000']);
    const text = readFileSync(join(root, 'records/loops/r1/resource-requests/a-retry-2.md'), 'utf8');
    expect(text.startsWith('## keys\nhero\n\n## previous attempt\n')).toBe(true);
    expect(text.split('## previous attempt').length).toBe(2);
    expect((await readJob(two.stdout.trim(), ws.env)).meta).toMatchObject({ retryRoot: first.id, retryNumber: 2 });
    expect(sh(root, 'git', ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    const committed = sh(root, 'git', ['log', '--name-only', '--format=']);
    expect(committed).toContain('records/loops/r1/resource-requests/a-retry-1.md');
    expect(committed).toContain('records/loops/r1/resource-requests/a-retry-2.md');
  });

  it('starts one retry when two retries of the same job run at the same time', async () => {
    const ws = makeWorkspace({ backgroundRetryLimit: 1 });
    const { root } = await gameWithRun(ws, { 'records/loops/r1/content-input-1.md': '## request\nnone\n' });
    const failing = fakeAgentCli(ws, 'process.exitCode = 1;');
    const first = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'records/loops/r1/content-input-1.md')], failing.env, root);
    const runs = await Promise.all([1, 2].map(() => ogw(ws, ['agent', 'retry', first.id, '--background'], { env: failing.env, cwd: root })));
    expect(runs.map((r) => r.code).sort()).toEqual([0, 1]);
    const started = (await listJobs(ws.env)).filter((j) => j.meta.retryRoot === first.id);
    expect(started).toHaveLength(1);
    await ogw(ws, ['agent', 'wait', started[0]?.id as string, '--timeout', '60000']);
  });

  it('does not retry a JSON input, a done job or a running job', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'in.md': 'x', 'guide.md': 'g' });
    const ok = fakeAgentCli(ws, WRITE_OUTPUT);
    const done = await runAgent(ws, ['content', '--game', 'g', '--input', 'in.md'], ok.env, root);
    expect((await ogw(ws, ['agent', 'retry', done.id])).stderr).toContain(`job ${done.id} ended with a result file`);
    if (process.platform === 'darwin') {
      writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'i', playGuide: join(root, 'guide.md'), moment: null }));
      const failing = fakeAgentCli(ws, 'process.exitCode = 1;');
      const play = await runAgent(ws, ['play', '--game', 'g', '--input', join(ws.root, 'play.json')], failing.env, root);
      expect((await ogw(ws, ['agent', 'retry', play.id])).stderr).toContain('has a JSON input (play)');
    }
    const slow = fakeAgentCli(ws, 'await new Promise((r) => setTimeout(r, 3000));');
    const running = (await ogw(ws, ['agent', 'content', '--game', 'g', '--input', 'in.md', '--background'], { env: slow.env, cwd: root })).stdout.trim();
    expect((await ogw(ws, ['agent', 'retry', running])).stderr).toContain(`job ${running} is running`);
    await ogw(ws, ['agent', 'wait', running, '--timeout', '30000']);
  });
});
