import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failedLines, sortFixRuns, testRuns } from '../../../src/commands/review/lib/run.ts';
import { jobsDir, listJobs, readJob, type JobRecord, type WaitResult } from '../../../src/lib/jobs.ts';
import { CORE_TEST_PASSED } from '../agent/helpers.ts';
import { writeJob } from '../job/helpers.ts';
import { ogw, commitAll, makeWorkspace, sh } from '../../helpers/workspace.ts';
import { agents, agentsByCall, changeDefinition, commitRange, coreSpec, finding, GOOD_FIX, implementServer, reviewFile, spec, toolsChange, UNTESTED_FIX } from './helpers.ts';

describe('ogw review run', () => {
  it('goes through a fix round, merges the fix, and stops at done', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([], ['| R1-1 | fixed | ok |']) }, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(fake.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(1);
    const status = await ogw(ws, ['review', 'status', 'core']);
    expect(status.stdout).toBe('routing round 2 done spec change: none job: none\n');
    // a done target starts no round
    expect(await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env })).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
  });

  it('gives the code check failures outside the target in its stop output', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'storage'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'package.json'), '{"type": "module"}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'package-lock.json'), '{"lockfileVersion": 3, "requires": true, "packages": {"": {}}}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'storage', 'index.ts'), "export const s: number = 'text';\n");
    commitAll(ws.coreImpl, 'a type check failure of storage');
    const fake = agents(ws, { 1: reviewFile([]) }, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: "result: done\nround: 1\ncode check fail outside target: server/core/storage/index.ts:1:14 TS2322 Type 'string' is not assignable to type 'number'.\n" });
  });

  it('calls the core agent once more when its fix is not merged, then stops with not merged', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]) }, UNTESTED_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/^result: not merged\nround: 1\nopen finding: R1-1 correctness high src\/a.ts:3 spec change: no\nnot merged: \w+: no core test: /);
    expect(fake.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(2);
  });

  it('merges a finished fix job of the last round first, and passes --module with the target', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([], ['| R1-1 | fixed | ok |']) }, GOOD_FIX);
    await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env });
    await ogw(ws, ['review', 'wait', 'core', 'routing', '--timeout', '120000']);
    const fixInput = join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'round-1-fix.md');
    const job = (await ogw(ws, ['agent', 'core', '--module', 'routing', '--input', fixInput, '--background'], { env: fake.env })).stdout.trim();
    await ogw(ws, ['agent', 'wait', job, '--timeout', '60000']);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(fake.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(1);
    expect(((await readJob(job, ws.env)).meta as { merged: boolean }).merged).toBe(true);
  });

  it('calls the core agent again instead of merging a fix job that failed, also when that job was merged', async () => {
    for (const mergeFailed of [false, true]) {
      const ws = makeWorkspace();
      coreSpec(ws, { routing: spec('routing', 'server') });
      // the first core agent ends without its report; the next one fixes
      const marker = join(ws.root, 'failed-once');
      const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([], ['| R1-1 | fixed | ok |']) },
        `if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(1); } ${GOOD_FIX}`);
      await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env });
      await ogw(ws, ['review', 'wait', 'core', 'routing', '--timeout', '120000']);
      const fixInput = join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'round-1-fix.md');
      const failed = (await ogw(ws, ['agent', 'core', '--module', 'routing', '--input', fixInput, '--background'], { env: fake.env })).stdout.trim();
      await ogw(ws, ['agent', 'wait', failed, '--timeout', '60000']);
      expect((await readJob(failed, ws.env)).status).not.toBe('done');
      if (mergeFailed) await ogw(ws, ['agent', 'merge', failed]);
      expect(await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env })).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
      expect(fake.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(2);
      expect(((await readJob(failed, ws.env)).meta as { merged: boolean }).merged).toBe(mergeFailed);
    }
  });

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

  it('goes on in a process of the changed harness code when the harness tools change during the run', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([], ['| R1-1 | fixed | ok |']) }, toolsChange(ws) + GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(run.stderr).toContain('the harness tools changed: ogw review run core routing goes on with the new code');
  });

  it('calls a fix agent with --module of the target', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([]) }, GOOD_FIX);
    await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    const cores = (await listJobs(ws.env)).filter((job) => job.command === 'agent' && job.meta.role === 'core');
    expect(cores.map((job) => job.meta.modules)).toEqual([['routing']]);
    expect(cores.map((job) => (job.meta as { outputRel: string }).outputRel)).toEqual([expect.stringMatching(new RegExp(`^records/\\d+-review-fix-${cores[0]?.id ?? ''}\\.md$`))]);
  });

  it('stops at blocked and at a second invalid round in a row', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server'), storage: spec('storage', 'server') });
    const blocked = agents(ws, { 1: reviewFile([finding('R1-1', 'yes')]) }, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: blocked.env });
    expect(run).toMatchObject({ code: 1, stdout: 'result: blocked\nround: 1\nopen finding: R1-1 correctness high src/a.ts:3 spec change: yes\n' });
    expect((await ogw(ws, ['review', 'status', 'core'])).stdout).toBe('routing round 1 blocked spec change: R1-1 job: none\n');
    const invalid = agents(ws, {}, GOOD_FIX);
    const twice = await ogw(ws, ['review', 'run', 'core', 'storage'], { env: invalid.env });
    const reviewPath = join(ws.coreImpl, 'records', 'review', 'storage-1.md');
    expect(twice).toMatchObject({ code: 1, stdout: `result: invalid\nround: 0\nreview file missing or not in the review file format: ${reviewPath}\n` });
    expect(invalid.calls()).toHaveLength(2);
    // --restart starts round 1 again once a definition document changed
    const refused = await ogw(ws, ['review', 'run', 'core', 'routing', '--restart'], { env: agents(ws, { 1: reviewFile([]) }, GOOD_FIX).env });
    expect(refused).toMatchObject({ code: 1 });
    expect(refused.stderr).toContain('--restart of routing: no definition document changed since round 1 started');
    changeDefinition(ws);
    const restarted = await ogw(ws, ['review', 'run', 'core', 'routing', '--restart'], { env: agents(ws, { 1: reviewFile([]) }, GOOD_FIX).env });
    expect(restarted).toMatchObject({ code: 0, stdout: 'result: done\nround: 1\n' });
  });

  it('escalates when the first chain reaches the limit, stops at limit when the escalation chain does, and goes on with --continue', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const open = (round: number): string => reviewFile([finding(`R${String(round)}-1`, 'no')]);
    const fake = agents(ws, { 1: open(1), 2: open(2), 3: open(3), 4: open(4), 5: open(5), 6: open(6), 7: reviewFile([]) }, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 1, stdout: 'result: limit\nround: 6\nopen finding: R6-1 correctness high src/a.ts:3 spec change: no\n' });
    const fixes = fake.calls().map((call) => /round-(\d)-(fix|escalation)\.md/.exec(call.prompt)?.slice(1).join(' ')).filter((x) => x !== undefined);
    expect(fixes).toEqual(['1 fix', '2 fix', '3 escalation', '4 fix', '5 fix']);
    const escalation = readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'round-3-escalation.md'), 'utf8');
    expect(escalation).toMatch(/^command: review fix\n- target: routing\n/);
    expect(escalation).toMatch(/## chain\n\n- round 1: review file \S+routing-1\.md, fix \w+\.\.\w+\n- round 2: review file \S+routing-2\.md, fix \w+\.\.\w+\n- round 3: review file \S+routing-3\.md\n$/);
    // limit starts no round until --continue, after the fix the human chose
    expect((await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env })).stdout).toBe('result: limit\nround: 6\nopen finding: R6-1 correctness high src/a.ts:3 spec change: no\n');
    // the fake core agent fixes on a `review fix` input; the lead's input for the human's fix names the same command here
    writeFileSync(join(ws.root, 'human-fix.md'), 'command: review fix\n- target: routing\n- the fix the human chose\n');
    const humanJob = (await ogw(ws, ['agent', 'core', '--module', 'routing', '--input', join(ws.root, 'human-fix.md'), '--background'], { env: fake.env })).stdout.trim();
    await ogw(ws, ['agent', 'wait', humanJob, '--timeout', '120000']);
    expect((await ogw(ws, ['agent', 'merge', humanJob])).stdout.split('\n')).toContain(`merged ${humanJob}`);
    // a --continue run whose round is dropped twice as invalid stops; a run started again goes on with the kept --continue
    const dropped = agents(ws, {}, GOOD_FIX);
    expect((await ogw(ws, ['review', 'run', 'core', 'routing', '--continue'], { env: dropped.env })).stdout).toMatch(/^result: invalid\n/);
    // one fake agent CLI per workspace: this one writes the round 7 review file again
    const again = agents(ws, { 7: reviewFile([]) }, GOOD_FIX);
    expect((await ogw(ws, ['review', 'run', 'core', 'routing'], { env: again.env })).stdout).toBe('result: done\nround: 7\n');
    // the new chain's review sees the report of the human's fix
    const report = join(ws.coreImpl, (await readJob(humanJob, ws.env)).meta.outputRel as string);
    // the reports section of the input lists that report alone
    expect(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'round-7-input.md'), 'utf8')).toContain(`## core agent reports\n\n- ${report}\n\n## spec changes\n\nnone\n`);
    const rounds = (JSON.parse(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json'), 'utf8')) as { rounds: { fixJobs?: string[] }[] }).rounds;
    expect(rounds[5]?.fixJobs).toEqual([humanJob]);
    const state = JSON.parse(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json'), 'utf8')) as { rounds: { round: number; chain: number; startCommit: string }[] };
    expect(state.rounds.map((r) => r.chain)).toEqual([1, 1, 1, 2, 2, 2, 3]);
    // the new chain reviews the changes from the start of the limit round
    expect(commitRange(ws, 'routing', 7)).toBe(`${state.rounds[5]?.startCommit as string}..${state.rounds[6]?.startCommit as string}`);
  }, 180_000);

  it('escalates when a finding is still open after two fixes, before the round limit', async () => {
    const ws = makeWorkspace({ reviewRounds: 5 });
    coreSpec(ws, { routing: spec('routing', 'server') });
    const files = {
      1: reviewFile([finding('R1-1', 'no')]),
      2: reviewFile([], ['| R1-1 | open | not fixed |']),
      3: reviewFile([], ['| R1-1 | open | not fixed |']),
      4: reviewFile([], ['| R1-1 | fixed | done |']),
    };
    const fake = agents(ws, files, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 4\n' });
    const fixes = fake.calls().map((call) => /round-(\d)-(fix|escalation)\.md/.exec(call.prompt)?.slice(1).join(' ')).filter((x) => x !== undefined);
    expect(fixes).toEqual(['1 fix', '2 fix', '3 escalation']);
  });

  it('runs no core test after a fix that changed only records/', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'routing'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), '');
    commitAll(ws.coreImpl, 'routing');
    const recordsFix = "fs.mkdirSync('records/notes', { recursive: true }); fs.writeFileSync('records/notes/fix.md', 'nothing to fix'); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'fix', '--no-verify']); fs.writeFileSync(output, 'report');";
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([], ['| R1-1 | fixed | ok |']) }, recordsFix);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect((await listJobs(ws.env)).filter((job) => job.command === 'core test')).toEqual([]);
  });

  it('runs the core test of an implemented dependent after the fix, and stops at test fail; a rerun with --since goes on at the core test', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'routing'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), '');
    // the module is there at `--since`: round 1 reviews the changes since it, not the whole module
    const since = commitAll(ws.coreImpl, 'routing');
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), 'export {};\n');
    const main = commitAll(ws.coreImpl, 'routing change');
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([]) }, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--since', since], { env: fake.env });
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/^result: test fail\nround: 1\nopen finding: R1-1 correctness high src\/a.ts:3 spec change: no\nogw core test server routing: /);
    // `--since` gives round 1 the changes from that commit
    expect(commitRange(ws, 'routing', 1)).toBe(`${since}..${main}`);
    const tests = (await listJobs(ws.env)).filter((job) => job.command === 'core test');
    expect(tests.map((job) => job.argv)).toEqual([['core', 'test', 'server', 'routing', '--json']]);
    // the run starts again at the core test: the fix is merged
    const again = await ogw(ws, ['review', 'run', 'core', 'routing', '--since', since], { env: fake.env });
    expect(again.stdout).toMatch(/^result: test fail\n/);
    expect((await listJobs(ws.env)).filter((job) => job.command === 'core test')).toHaveLength(2);
    expect(fake.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(1);
  });

  it('keeps --since for a round 1 started again after an invalid one', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    mkdirSync(join(ws.coreImpl, 'tools', 'routing'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'tools', 'routing', 'a.txt'), 'x');
    const since = commitAll(ws.coreImpl, 'routing');
    writeFileSync(join(ws.coreImpl, 'changed.txt'), 'x');
    const main = commitAll(ws.coreImpl, 'change');
    const fake = agentsByCall(ws, { 2: reviewFile([], [], ['- src/old.ts:4: high an old bug']) }, GOOD_FIX);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--since', since], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 1\nout of scope: round 1: src/old.ts:4: high an old bug\nround 1: review must fix added: routing M1: src/old.ts:4: high an old bug\n' });
    expect(commitRange(ws, 'routing', 1)).toBe(`${since}..${main}`);
  });

  it('hands the count of invalid rounds in a row to the process of the changed harness code', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    // call 1 writes no review file and changes the harness tools; call 2 writes none either: the second invalid in a row
    const fake = agentsByCall(ws, { 3: reviewFile([]) }, GOOD_FIX, { 1: toolsChange(ws) });
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run.stderr).toContain('the harness tools changed: ogw review run core routing goes on with the new code');
    const reviewPath = join(ws.coreImpl, 'records', 'review', 'routing-1.md');
    expect(run).toMatchObject({ code: 1, stdout: `result: invalid\nround: 0\nreview file missing or not in the review file format: ${reviewPath}\n` });
    expect(fake.calls()).toHaveLength(2);
  });

  it('goes on after a blocked round with --respec, and starts the --respec round again after it was judged invalid', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    // call 2, the first --respec round, writes no review file
    const fake = agentsByCall(ws, { 1: reviewFile([finding('R1-1', 'yes')]), 3: reviewFile([], ['| R1-1 | fixed | spec changed |']) }, GOOD_FIX);
    expect((await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env })).stdout).toMatch(/^result: blocked\nround: 1\n/);
    changeDefinition(ws);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--respec'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(fake.calls()).toHaveLength(3);
    const dir = join(ws.coreImpl, '.git', 'ogw-review', 'routing');
    expect(readFileSync(join(dir, 'round-2-input.md'), 'utf8')).toContain(`## spec changes\n\n${join(dir, 'round-2-spec-changes.diff')}\n`);
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { respecAfter?: number; rounds: { chain?: number }[] };
    expect(state.rounds.map((r) => r.chain)).toEqual([1, 2]);
    expect(state.respecAfter).toBeUndefined();
  });

  it('with --respec judges a round left unjudged first, then starts the --respec round after it', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agentsByCall(ws, { 1: reviewFile([finding('R1-1', 'yes')]), 2: reviewFile([], ['| R1-1 | fixed | spec changed |']) }, GOOD_FIX);
    // a run that was ended left round 1 unjudged
    expect((await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env })).stdout).toMatch(/^round: 1\n/);
    changeDefinition(ws);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--respec'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    const dir = join(ws.coreImpl, '.git', 'ogw-review', 'routing');
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { respecAfter?: number; rounds: { chain?: number; result: string }[] };
    expect(state.rounds.map((r) => [r.chain, r.result])).toEqual([[1, 'blocked'], [2, 'done']]);
    expect(state.respecAfter).toBeUndefined();
    expect(readFileSync(join(dir, 'round-2-input.md'), 'utf8')).toContain(`## spec changes\n\n${join(dir, 'round-2-spec-changes.diff')}\n`);
  });

  it('with --respec follows a kept --respec round left unjudged with another round when a definition changed after it started', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agentsByCall(ws, { 1: reviewFile([finding('R1-1', 'yes')]), 2: reviewFile([], ['| R1-1 | fixed | spec changed |']), 3: reviewFile([]) }, GOOD_FIX);
    await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env });
    expect((await ogw(ws, ['review', 'wait', 'core', 'routing', '--timeout', '120000'])).stdout).toMatch(/^result: blocked\n/);
    changeDefinition(ws);
    // a --respec run that was ended left its round 2 unjudged, and the spec changed again
    expect((await ogw(ws, ['review', 'next', 'core', 'routing', '--respec'], { env: fake.env })).stdout).toMatch(/^round: 2\n/);
    appendFileSync(join(ws.harness, 'skills', 'core', 'command.md'), '\n- changed again\n');
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--respec'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 3\n' });
    const dir = join(ws.coreImpl, '.git', 'ogw-review', 'routing');
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { rounds: { chain?: number; result: string }[] };
    expect(state.rounds.map((r) => [r.chain, r.result])).toEqual([[1, 'blocked'], [2, 'done'], [3, 'done']]);
    expect(readFileSync(join(dir, 'round-3-spec-changes.diff'), 'utf8')).toContain('changed again');
  });

  it('with --respec goes on with round 1 when the round 1 left unjudged is judged invalid and dropped', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    // call 1 writes no review file: its round 1 is invalid
    const fake = agentsByCall(ws, { 2: reviewFile([]) }, GOOD_FIX);
    expect((await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env })).stdout).toMatch(/^round: 1\n/);
    changeDefinition(ws);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--respec'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 1\n' });
    const state = JSON.parse(readFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'state.json'), 'utf8')) as { respecAfter?: number; rounds: { result: string }[] };
    expect(state.rounds.map((r) => r.result)).toEqual(['done']);
    expect(state.respecAfter).toBeUndefined();
  });

  it('merges the fix of the last round before a --respec round', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const files = { 1: reviewFile([finding('R1-1', 'no'), finding('R1-2', 'yes')]), 2: reviewFile([], ['| R1-1 | fixed | ok |', '| R1-2 | fixed | spec changed |']) };
    const fake = agents(ws, files, GOOD_FIX);
    await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env });
    expect((await ogw(ws, ['review', 'wait', 'core', 'routing', '--timeout', '120000'])).stdout).toMatch(/^result: fix\n/);
    // the lead's core agent of the fix input ended and was not merged yet
    const dir = join(ws.coreImpl, '.git', 'ogw-review', 'routing');
    const job = (await ogw(ws, ['agent', 'core', '--module', 'routing', '--input', join(dir, 'round-1-fix.md'), '--background'], { env: fake.env })).stdout.trim();
    await ogw(ws, ['agent', 'wait', job, '--timeout', '60000']);
    changeDefinition(ws);
    const run = await ogw(ws, ['review', 'run', 'core', 'routing', '--respec'], { env: fake.env });
    expect(run).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(((await readJob(job, ws.env)).meta as { merged: boolean }).merged).toBe(true);
    const input = readFileSync(join(dir, 'round-2-input.md'), 'utf8');
    expect(input).toContain(`## core agent reports\n\n- ${join(ws.coreImpl, (await readJob(job, ws.env)).meta.outputRel as string)}\n`);
    expect(input).toContain(`## spec changes\n\n${join(dir, 'round-2-spec-changes.diff')}\n`);
  });


  it('judges a round that the review next of an earlier run left, and counts its invalid result', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const fake = agents(ws, {}, GOOD_FIX);
    await ogw(ws, ['review', 'next', 'core', 'routing'], { env: fake.env });
    const run = await ogw(ws, ['review', 'run', 'core', 'routing'], { env: fake.env });
    expect(run.stdout).toMatch(/^result: invalid\nround: 0\n/);
    expect(fake.calls()).toHaveLength(2);
    const judged = agents(ws, { 1: reviewFile([]) }, GOOD_FIX);
    await ogw(ws, ['review', 'next', 'core', 'routing'], { env: judged.env });
    expect(await ogw(ws, ['review', 'run', 'core', 'routing'], { env: judged.env })).toMatchObject({ code: 0, stdout: 'result: done\nround: 1\n' });
    expect(judged.calls()).toHaveLength(1);
  });

  it('waits for a running fix job of the last round, and starts at the next round when the fix is merged', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const slow = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([]) }, `execFileSync('sleep', ['2']); ${GOOD_FIX}`);
    await ogw(ws, ['review', 'next', 'core', 'routing'], { env: slow.env });
    await ogw(ws, ['review', 'wait', 'core', 'routing', '--timeout', '120000']);
    const fixInput = join(ws.coreImpl, '.git', 'ogw-review', 'routing', 'round-1-fix.md');
    const job = (await ogw(ws, ['agent', 'core', '--module', 'routing', '--input', fixInput, '--background'], { env: slow.env })).stdout.trim();
    expect(await ogw(ws, ['review', 'run', 'core', 'routing'], { env: slow.env })).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(slow.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(1);
    expect(((await readJob(job, ws.env)).meta as { merged: boolean }).merged).toBe(true);

    const merged = makeWorkspace();
    coreSpec(merged, { routing: spec('routing', 'server') });
    const fake = agents(merged, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([]) }, GOOD_FIX);
    await ogw(merged, ['review', 'next', 'core', 'routing'], { env: fake.env });
    await ogw(merged, ['review', 'wait', 'core', 'routing', '--timeout', '120000']);
    const input = join(merged.coreImpl, '.git', 'ogw-review', 'routing', 'round-1-fix.md');
    const fixed = (await ogw(merged, ['agent', 'core', '--module', 'routing', '--input', input, '--background'], { env: fake.env })).stdout.trim();
    await ogw(merged, ['agent', 'wait', fixed, '--timeout', '60000']);
    await ogw(merged, ['agent', 'merge', fixed]);
    expect(await ogw(merged, ['review', 'run', 'core', 'routing'], { env: fake.env })).toMatchObject({ code: 0, stdout: 'result: done\nround: 2\n' });
    expect(fake.calls().filter((call) => call.prompt.includes('round-1-fix.md'))).toHaveLength(1);
  });

  it('runs at most reviewRunConcurrency review agent, core agent and core test jobs at once across the runs of the host', async () => {
    const ws = makeWorkspace({ reviewRunConcurrency: 1 });
    coreSpec(ws, { routing: spec('routing', 'server'), storage: spec('storage', 'server') });
    implementServer(ws, ['routing', 'storage']);
    const fake = agents(ws, { 1: reviewFile([finding('R1-1', 'no')]) }, GOOD_FIX);
    const both = await Promise.all(['routing', 'storage'].map((target) => ogw(ws, ['review', 'run', 'core', target], { env: fake.env })));
    expect(both.map((run) => /^result: (.+)$/m.exec(run.stdout)?.[1])).toEqual(['test fail', 'test fail']);
    // every review agent, core agent and core test job of the two runs, as the job records time them
    const jobs = (await listJobs(ws.env)).filter((job) => job.command === 'agent' || job.command === 'core test');
    expect(jobs.map((job) => job.command).sort()).toEqual(['agent', 'agent', 'agent', 'agent', 'core test', 'core test']);
    const spans = jobs.map((job) => [job.startedAt, job.endedAt as number] as const).sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < spans.length; i += 1) expect(spans[i]?.[0]).toBeGreaterThanOrEqual(spans[i - 1]?.[1] as number);
  });

  it('shows running before a round is judged, the spec change findings of the last judged round, a running job, and tool targets', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: spec('routing', 'server') });
    const blocked = agents(ws, { 1: reviewFile([finding('R1-1', 'yes')]) }, GOOD_FIX);
    await ogw(ws, ['review', 'run', 'core', 'routing'], { env: blocked.env });
    const slow = agents(ws, { 1: reviewFile([]) }, GOOD_FIX);
    const slowEnv = { ...slow.env };
    writeFileSync(join(ws.root, 'fake-bin', 'fake.mjs'), readFileSync(join(ws.root, 'fake-bin', 'fake.mjs'), 'utf8').replace("const prompt =", "execFileSync('sleep', ['3']); const prompt ="));
    expect((await ogw(ws, ['review', 'status', 'core'])).stdout).toBe('routing round 1 blocked spec change: R1-1 job: none\n');
    // a blocked target starts no round until the human changed the spec
    expect((await ogw(ws, ['review', 'next', 'core', 'routing'], { env: slowEnv })).stdout).toBe('blocked\n');
    changeDefinition(ws);
    await ogw(ws, ['review', 'next', 'core', 'routing', '--restart'], { env: slowEnv });
    expect((await ogw(ws, ['review', 'status', 'core'])).stdout).toBe('routing round 1 running spec change: none job: none\n');
    await ogw(ws, ['review', 'wait', 'core', 'routing', '--timeout', '120000']);
    changeDefinition(ws);
    const job = (await ogw(ws, ['review', 'run', '--restart', 'core', 'routing', '--background'], { env: slowEnv })).stdout.trim();
    let shown = '';
    for (let i = 0; i < 50 && !shown.includes(`job: ${job}`); i += 1) {
      shown = (await ogw(ws, ['review', 'status', 'core'])).stdout;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(shown).toContain(`job: ${job}`);
    await ogw(ws, ['job', 'wait', job, '--timeout', '120000']);
    const tool = agents(ws, { 1: reviewFile([]) }, GOOD_FIX);
    await ogw(ws, ['review', 'next', 'tool', 'agent', 'merge', '--since', 'HEAD', '--definition', join(ws.harness, 'tools', 'ogw.md')], { env: tool.env });
    await ogw(ws, ['review', 'wait', 'tool', 'agent', 'merge', '--timeout', '120000']);
    expect((await ogw(ws, ['review', 'status', 'tool'])).stdout).toBe('agent merge round 1 done spec change: none job: none\n');
  });

  it('fails at once while a run of the same target holds its lock, and checks the arguments', async () => {
    const ws = makeWorkspace();
    const lock = join(ws.coreImpl, '.git', 'ogw-review', 'routing.run.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), `${String(process.pid)}\n`);
    const refused = await ogw(ws, ['review', 'run', 'core', 'routing']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('an ogw review run job of routing is running');
    expect((await ogw(ws, ['review', 'run', 'tool', 'agent', 'merge'])).stderr).toContain('usage: ogw review run core <target> [--since <commit>|--full|--debt] [--restart|--respec|--continue|--reopen]');
    expect((await ogw(ws, ['review', 'status', 'x'])).stderr).toContain('usage: ogw review status <core|tool>');
    rmSync(lock, { recursive: true, force: true });
    coreSpec(ws, { routing: spec('routing', 'server') });
    expect((await ogw(ws, ['review', 'run', 'core', 'routing'], { env: agents(ws, { 1: reviewFile([]) }, GOOD_FIX).env })).stdout).toBe('result: done\nround: 1\n');
    const notLimit = await ogw(ws, ['review', 'run', 'core', 'routing', '--continue']);
    expect(notLimit).toMatchObject({ code: 1 });
    expect(notLimit.stderr).toContain('--continue needs the last round of routing to be limit');
  });
});

describe('testRuns', () => {
  it('runs the tool tests for a tool, and the implemented dependents per server and engine for a module', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, {
      storage: spec('storage', 'server'),
      routing: spec('routing', 'server', ['storage']),
      mailbox: spec('mailbox', 'server', ['routing']),
      ranking: spec('ranking', 'server'),
      UICore: spec('UICore', 'client', ['storage']),
      LogCore: spec('LogCore', 'client', ['storage']),
    });
    for (const module of ['storage', 'routing']) {
      mkdirSync(join(ws.coreImpl, 'server', 'core', module), { recursive: true });
      writeFileSync(join(ws.coreImpl, 'server', 'core', module, 'index.ts'), '');
    }
    mkdirSync(join(ws.coreImpl, 'client', 'godot', 'core', 'ui_core'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'core', 'ui_core', 'ui_core.gd'), '');
    expect(await testRuns(ws.coreImpl, 'storage')).toEqual([['server', 'routing', 'storage'], ['godot', 'UICore'], ['godot', 'UICore', '--web']]);
    expect(await testRuns(ws.coreImpl, 'ranking')).toEqual([]);
    expect(await testRuns(ws.coreImpl, 'data-tool')).toEqual([['tools']]);
    await expect(testRuns(ws.coreImpl, 'nothing')).rejects.toThrow('not in core-spec: nothing');
  });
});

describe('failedLines', () => {
  const waited = (stdout: string, exitCode: number, stderr = ''): WaitResult => ({ job: { exitCode } as JobRecord, finished: true, stdout, stderr });

  it('names each failed module with its failures, and a run that stopped before its tests', () => {
    // a module skipped for its failed dependency is not a failed test: the dependency's lines say why
    const json = JSON.stringify({ modules: { routing: 'pass', storage: 'fail', chat: 'skipped' }, failures: { storage: ['sqlite run: a.test.ts x'], chat: [] } });
    expect(failedLines(['server', 'routing', 'storage', 'chat'], waited(json, 1))).toEqual([
      'ogw core test server routing storage chat: storage fail',
      '  sqlite run: a.test.ts x',
    ]);
    expect(failedLines(['server'], waited(JSON.stringify({ modules: { routing: 'pass' } }), 0))).toEqual([]);
    // a tool whose engine round trip was left out has no failing test, though the run ends with exit code 1
    const leftOut = JSON.stringify({ modules: { 'data-tool': 'skipped' }, failures: { 'data-tool': [] }, skipped: { 'data-tool': 'godot round trip left out: x' } });
    expect(failedLines(['tools'], waited(leftOut, 1))).toEqual([]);
    expect(failedLines(['tools'], waited(JSON.stringify({ error: 'core-spec/ check failed' }), 1))).toEqual(['ogw core test tools: core-spec/ check failed']);
    expect(failedLines(['godot', '--web'], waited('', 1, 'boom\nmore'))).toEqual(['ogw core test godot --web: exit code 1: boom']);
  });
});

describe('core test failures after a fix', () => {
  it('stops for the target, a run that failed otherwise, or another module that passed before the fix, and keeps one that failed before', async () => {
    const run = (failed: string[] | null, line: string) => ({ args: ['server', 'routing', 'auth', 'mailbox'], lines: [line], failed });
    const before = new Set(['mailbox']);
    const failedBefore = (_args: readonly string[], module: string): Promise<boolean> => Promise.resolve(before.has(module));
    expect(await sortFixRuns([run(['mailbox'], 'm')], 'routing', failedBefore)).toEqual({ stopping: [], preexisting: ['m'] });
    expect(await sortFixRuns([run(['auth'], 'a')], 'routing', failedBefore)).toEqual({ stopping: ['a'], preexisting: [] });
    expect(await sortFixRuns([run(['auth', 'mailbox'], 'am')], 'routing', failedBefore)).toEqual({ stopping: ['am'], preexisting: [] });
    expect(await sortFixRuns([run(['routing', 'mailbox'], 'rm')], 'routing', failedBefore)).toEqual({ stopping: ['rm'], preexisting: [] });
    expect(await sortFixRuns([run(null, 'x')], 'routing', failedBefore)).toEqual({ stopping: ['x'], preexisting: [] });
  });
});
