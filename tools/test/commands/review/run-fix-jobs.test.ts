import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jobsDir, listJobs, readJob } from '../../../src/lib/jobs.ts';
import { CORE_TEST_PASSED } from '../agent/helpers.ts';
import { writeJob } from '../job/helpers.ts';
import { ogw, makeWorkspace, sh } from '../../helpers/workspace.ts';
import { agents, coreSpec, finding, GOOD_FIX, reviewFile, spec } from './helpers.ts';

describe('ogw review run', () => {
  it('does not merge a core agent it called that ended without done, and stops with not merged after the second', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]) }, `fs.writeFileSync('partial.txt', '1'); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'partial', '--no-verify']); ${CORE_TEST_PASSED} process.exit(1);`);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run.stdout).toMatch(/^result: not merged$/m);
    expect(fake.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(2);
    const fixes = (await listJobs(ws.env)).filter((job) => job.command === 'agent' && job.meta.role === 'core');
    expect(fixes.map((job) => (job.meta as { merged: boolean }).merged)).toEqual([false, false]);
  });

  it('merges the newest done fix job not merged yet before calling the core agent, though a later job failed', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const marker = join(ws.root, 'fixed-once');
    // the first core agent fixes, the next one ends without its report
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([], ['| R1-1 | fixed | ok |']) },
      `if (fs.existsSync(${JSON.stringify(marker)})) process.exit(1); fs.writeFileSync(${JSON.stringify(marker)}, '1'); ${GOOD_FIX}`);
    await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env });
    await ogw(ws, ['review', 'wait', 'core', 'routing', '--timeout', '120000']);
    const fixInput = join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'round-1-fix.md');
    const done = (await ogw(ws, ['agent', 'core', '--module', 'routing', '--input', fixInput, '--background'], { env: fake.env })).stdout.trim();
    await ogw(ws, ['agent', 'wait', done, '--timeout', '60000']);
    const failed = (await ogw(ws, ['agent', 'core', '--module', 'routing', '--input', fixInput, '--background'], { env: fake.env })).stdout.trim();
    await ogw(ws, ['agent', 'wait', failed, '--timeout', '60000']);
    expect(await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env })).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(fake.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(2);
    expect(((await readJob(done, ws.env)).meta as { merged: boolean }).merged).toBe(true);
  });

  it('gives the game impact lines of its rounds in its stop output and does not count a finding in a game file', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const game = '| R1-1 | `correctness` | high | games/pong/a.tres:3 | z is 1 | set 0 | no | 90 |';
    const fake = agents(ws, { 1: reviewFile([game], [], ['- games/pong/b.tres:5: high z is 1 too']) }, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 1\ngame impact: round 1: games/pong/a.tres:3: high R1-1 z is 1\ngame impact: round 1: games/pong/b.tres:5: high z is 1 too\n' });
  });

  it('removes at review clear core what core agents which do not run left, named from the job id, and keeps a running one', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const calls = join(ws.root, 'calls');
    // the first core agent fails, the second fixes and is not merged, the third runs until the test ends it
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]) }, [
      `const n = (fs.existsSync(${JSON.stringify(calls)}) ? Number(fs.readFileSync(${JSON.stringify(calls)}, 'utf8')) : 0) + 1;`,
      `fs.writeFileSync(${JSON.stringify(calls)}, String(n));`,
      `if (n === 1) process.exit(1); if (n === 3) execFileSync('sleep', ['30']); ${GOOD_FIX}`,
    ].join(' '));
    await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env });
    await ogw(ws, ['review', 'wait', 'core', 'routing', '--timeout', '120000']);
    const fixInput = join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'round-1-fix.md');
    const start = async (): Promise<string> => (await ogw(ws, ['agent', 'core', '--module', 'routing', '--input', fixInput, '--background'], { env: fake.env })).stdout.trim();
    const failed = await start();
    await ogw(ws, ['agent', 'wait', failed, '--timeout', '60000']);
    const unmerged = await start();
    await ogw(ws, ['agent', 'wait', unmerged, '--timeout', '60000']);
    expect([(await readJob(failed, ws.env)).status, (await readJob(unmerged, ws.env)).status]).toEqual(['failed', 'done']);
    const running = await start();
    const tree = (id: string): string => join(ws.root, 'worktrees', '_core', `agent-${id}`);
    for (let i = 0; i < 100 && !existsSync(tree(running)); i += 1) await new Promise((r) => setTimeout(r, 100));
    // a job that ended during the worktree add has no worktree or branch in its meta
    const record = join(await jobsDir(ws.env), `${failed}.json`);
    const job = JSON.parse(readFileSync(record, 'utf8')) as { meta: Record<string, unknown> };
    writeFileSync(record, JSON.stringify({ ...job, meta: { ...job.meta, worktree: null, branch: null } }));
    // a worktree folder that is gone while git still lists it
    rmSync(tree(unmerged), { recursive: true, force: true });
    expect(await ogw(ws, ['review', 'clear', 'core'])).toMatchObject({ code: 0, stdout: 'cleared core review state\n' });
    expect([existsSync(tree(failed)), existsSync(tree(running))]).toEqual([false, true]);
    const branches = sh(ws.coreImpl, 'git', ['branch', '--format=%(refname:short)']);
    expect([failed, unmerged, running].map((id) => branches.includes(`agent/${id}`))).toEqual([false, false, true]);
    expect(sh(ws.coreImpl, 'git', ['worktree', 'list'])).not.toContain(`agent-${unmerged}`);
    await ogw(ws, ['agent', 'stop', running]);
    // a branch checked out in a worktree outside the agent worktrees cannot be removed: it is named
    const elsewhere = join(ws.root, 'elsewhere');
    sh(ws.coreImpl, 'git', ['worktree', 'add', '--force', elsewhere, `agent/${running}`]);
    // a folder at an agent worktree path that git does not list is no worktree to remove: it is named
    mkdirSync(tree(failed), { recursive: true });
    writeFileSync(join(tree(failed), 'x'), '');
    const cleared = await ogw(ws, ['review', 'clear', 'core']);
    expect(cleared.code).toBe(0);
    expect(cleared.stdout.split('\n').sort()).toEqual(['', 'cleared core review state', `not removed: ${tree(failed)}`, `not removed: agent/${running}`].sort());
    expect(existsSync(tree(running))).toBe(false);
  });

  it('waits for an older fix job that runs though a newer one failed, and merges it instead of calling the core agent', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const marker = join(ws.root, 'called-once');
    const release = join(ws.root, 'release-slow-fix');
    // the first core agent fixes only after the test releases it (a fixed sleep ran out under load), the second one fails at once
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([], ['| R1-1 | fixed | ok |']) },
      `if (fs.existsSync(${JSON.stringify(marker)})) process.exit(1); fs.writeFileSync(${JSON.stringify(marker)}, '1'); for (let i = 0; i < 1200 && !fs.existsSync(${JSON.stringify(release)}); i += 1) execFileSync('sleep', ['0.05']); ${GOOD_FIX}`);
    await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env });
    await ogw(ws, ['review', 'wait', 'core', 'routing', '--timeout', '120000']);
    const fixInput = join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'round-1-fix.md');
    const slow = (await ogw(ws, ['agent', 'core', '--module', 'routing', '--input', fixInput, '--background'], { env: fake.env })).stdout.trim();
    for (let i = 0; i < 100 && !existsSync(marker); i += 1) await new Promise((r) => setTimeout(r, 100));
    const failed = (await ogw(ws, ['agent', 'core', '--module', 'routing', '--input', fixInput, '--background'], { env: fake.env })).stdout.trim();
    await ogw(ws, ['agent', 'wait', failed, '--timeout', '60000']);
    expect((await readJob(slow, ws.env)).status).toBe('running');
    writeFileSync(release, '1');
    expect(await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env })).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(fake.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(2);
    expect(((await readJob(slow, ws.env)).meta as { merged: boolean }).merged).toBe(true);
  });

  it('does not take a merged job of the same fix input that started before the round was judged as its fix', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fixInput = join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'round-1-fix.md');
    const meta = { role: 'core', modules: ['routing'], input: fixInput, taskInput: fixInput, merged: true };
    const jobs = await jobsDir(ws.env);
    mkdirSync(jobs, { recursive: true });
    writeJob(jobs, { id: 'mv0earlier0fix', command: 'agent', argv: ['agent', '__run'], startedAt: 1, endedAt: 2, status: 'done', exitCode: 0, meta });
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([], ['| R1-1 | fixed | ok |']) }, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(fake.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(1);
    const state = JSON.parse(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json'), 'utf8')) as { rounds: { fixJobs?: string[] }[] };
    expect(state.rounds[0]?.fixJobs).not.toContain('mv0earlier0fix');
  });
});
