import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hardeningRecords } from '../../../src/commands/loop/lib/findings.ts';
import { formatReviewInput } from '../../../src/commands/review/lib/input.ts';
import { instancesDir } from '../../../src/commands/instance/lib/records.ts';
import { jobsDir, readJob } from '../../../src/lib/jobs.ts';
import { changeRuns, requireOpenRun } from '../../../src/lib/runstate.ts';
import { createContext } from '../../../src/lib/command.ts';
import { startAgentJob } from '../../../src/commands/agent/api.ts';
import { cliEntry } from '../../../src/lib/paths.ts';
import { privateTempDir } from '../../../src/lib/secret-files.ts';
import { cliToRun, otherGameFolders } from '../../../src/commands/agent/lib/launch.ts';
import type { AgentSettings } from '../../../src/lib/settings.ts';
import { ogw, commitAll, gitEnv, makeGame, makeWorkspace, sh, testSettings } from '../../helpers/workspace.ts';
import { fakeAgentCli, gameWithRun, noUsage, readRunLog, runAgent, WRITE_OUTPUT } from './helpers.ts';

const RUN_OGW = `execFileSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(cliEntry())}, 'job', 'status', 'nojob'], { stdio: 'ignore' }) ;`;

/** Real output of the agent CLIs on this host (`test/commands/agent/lib/usage.test.ts`). */
function usageFixture(name: string): string {
  return join(import.meta.dirname, '..', '..', 'fixtures', 'agent-usage', name);
}

function log(root: string, rev: string, path: string): string {
  return sh(root, 'git', ['show', `${rev}:${path}`]);
}

describe('ogw agent: content', () => {
  it('stops the instances its agent started when the job ends', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'records/loops/r1/content-input-1.md': '## request\nnone\n' });
    const dir = await instancesDir(ws.env);
    mkdirSync(dir, { recursive: true });
    // the fake agent leaves one running instance of its own (its record names the agent's job) and exits
    const record = (id: string, agentJob: string): string =>
      JSON.stringify({ id, game: 'g', root, mainRoot: root, worktree: null, commit: '', platform: 'macos', status: 'running', error: null, failure: null, startedAt: 1, ownerPid: 999999, agentJob, supervisorPid: null, serverUrl: '', adminSecret: '', control: null, pids: {}, exited: {}, container: null, plan: null });
    writeFileSync(join(dir, 'otheragent.json'), record('otheragent', 'someotherjob'));
    const behavior = [
      "const job = (process.env.OGW_AGENT_KEY ?? '').split('.')[0];",
      `fs.writeFileSync(${JSON.stringify(join(dir, 'leftinst1.json'))}, ${JSON.stringify(record('leftinst1', '__JOB__'))}.replace('__JOB__', job));`,
      WRITE_OUTPUT,
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    const { waited } = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'records/loops/r1/content-input-1.md')], fake.env, root);
    expect(waited.code).toBe(0);
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).sort()).toEqual(['otheragent.json']);
  });

  it('continues the session of the content agent of the previous fun iteration of the run when its file is kept', async () => {
    const ws = makeWorkspace();
    const inputs = Object.fromEntries([1, 2, 3, 4].map((n) => [`records/loops/r1/content-input-${String(n)}.md`, '## kind\nfun\n']));
    const kinds = [1, 2, 3, 4].map((iteration) => ({ iteration, kind: iteration === 3 ? 'completeness' : 'fun' }));
    const { root, game } = await gameWithRun(ws, inputs, { data: { loop: { kinds } } });
    // the fake Claude Code keeps the session file of a new session, as `claude -p` does in its config folder
    const keep = [
      "const at = process.argv.indexOf('--session-id');",
      "if (at > 0) { const dir = process.env.CLAUDE_CONFIG_DIR + '/projects/-games-g'; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dir + '/' + process.argv[at + 1] + '.jsonl', '{}\\n'); }",
      WRITE_OUTPUT,
    ].join('\n');
    const fake = fakeAgentCli(ws, keep);
    const iterate = async (n: number): Promise<string[]> => {
      await changeRuns(game, (runs) => {
        (runs[0] as { iteration: number }).iteration = n;
      });
      const { waited } = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, `records/loops/r1/content-input-${String(n)}.md`)], fake.env, root);
      expect(waited.code).toBe(0);
      return fake.calls().at(-1)?.argv.slice(9) ?? [];
    };
    // iteration 1: a new session
    const [flag1, first] = await iterate(1);
    expect(flag1).toBe('--session-id');
    // iteration 2, a fun iteration after a fun iteration: the session of iteration 1 continued
    expect(await iterate(2)).toEqual(['--resume', first]);
    // iteration 3 is a completeness iteration, and iteration 4 follows it: new sessions
    const [flag3, third] = await iterate(3);
    expect(flag3).toBe('--session-id');
    expect(third).not.toBe(first);
    const [flag4] = await iterate(4);
    expect(flag4).toBe('--session-id');
    // a session whose file is not kept is not continued
    rmSync(join(ws.env.CLAUDE_CONFIG_DIR as string, 'projects'), { recursive: true, force: true });
    await changeRuns(game, (runs) => {
      (runs[0] as unknown as { data: { loop: { kinds: object[] } } }).data.loop.kinds.push({ iteration: 5, kind: 'fun' });
    });
    writeFileSync(join(root, 'records/loops/r1/content-input-5.md'), '## kind\nfun\n');
    const [flag5] = await iterate(5);
    expect(flag5).toBe('--session-id');
  });

  it('runs a variant agent in its own worktree of the work branch HEAD with a new session, which no later content agent continues', async () => {
    const ws = makeWorkspace();
    const inputs = Object.fromEntries([1, 3].map((n) => [`records/loops/r1/content-input-${String(n)}.md`, '## kind\nfun\n']));
    const kinds = [1, 2, 3].map((iteration) => ({ iteration, kind: 'fun' }));
    const { root, game } = await gameWithRun(ws, { ...inputs, 'records/loops/r1/content-input-2-v2.md': '## kind\nfun\n\n## variant\n\n- variant: 2 of 2\n- element: no friction\n' }, { data: { loop: { kinds } } });
    const keep = [
      "const at = process.argv.indexOf('--session-id');",
      "if (at > 0) { const dir = process.env.CLAUDE_CONFIG_DIR + '/projects/-games-g'; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dir + '/' + process.argv[at + 1] + '.jsonl', '{}\\n'); }",
      "fs.writeFileSync('client.gd', 'variant'); fs.writeFileSync(output, 'report\\n');",
      "if (process.cwd().includes('agent-')) { execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'variant']); }",
    ].join('\n');
    const fake = fakeAgentCli(ws, keep);
    const iteration = async (n: number): Promise<void> => {
      await changeRuns(game, (runs) => {
        (runs[0] as { iteration: number }).iteration = n;
      });
    };
    // iteration 1: a content agent in the checkout, whose session file is kept
    expect((await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'records/loops/r1/content-input-1.md')], fake.env, root)).waited.code).toBe(0);
    commitAll(root, 'iteration 1');
    // iteration 2: a variant agent, in a fun iteration after a fun iteration, starts a new session in its worktree
    await iteration(2);
    const base = sh(root, 'git', ['rev-parse', 'HEAD']).trim();
    const ctx = createContext({ cwd: root, env: { ...ws.env, ...fake.env }, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const id = await startAgentJob(ctx, { role: 'content', game: 'g', input: join(root, 'records/loops/r1/content-input-2-v2.md'), variant: 2 });
    const worktree = join(ws.worktrees, 'g', `agent-${id}`);
    const output = join(worktree, 'records/loops/r1/content-2-v2.md');
    expect(await ogw(ws, ['agent', 'wait', id, '--timeout', '60000'], { env: fake.env })).toMatchObject({ code: 0, stdout: `${output}\n` });
    const call = fake.calls().at(-1);
    expect(call?.cwd).toBe(worktree);
    expect(call?.prompt).toContain(`- output: ${output}\n- run: r1\n- iteration: 2`);
    expect(call?.argv[9]).toBe('--session-id');
    expect((await readJob(id, ws.env)).meta).toMatchObject({ variant: 2, branch: `agent/${id}`, place: { kind: 'game-worktree', branch: 'loop/r1', baseCommit: base } });
    expect(sh(root, 'git', ['log', '--format=%s', `${base}..agent/${id}`]).trim().split('\n')).toContain('variant');
    expect(sh(root, 'git', ['rev-parse', 'HEAD']).trim()).toBe(base);
    // iteration 3 after the variant iteration: no session of a content agent that was not a variant agent, so a new one
    await iteration(3);
    expect((await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'records/loops/r1/content-input-3.md')], fake.env, root)).waited.code).toBe(0);
    expect(fake.calls().at(-1)?.argv[9]).toBe('--session-id');
    await expect(startAgentJob(ctx, { role: 'resource', game: 'g', input: join(root, 'records/loops/r1/content-input-3.md'), variant: 1 })).rejects.toThrow('a variant is a positive integer given only to role content');
  });

  it('runs a content agent with the agent CLI, model and effort given to the job instead of harness settings', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'records/loops/r1/content-input-1.md': '## kind\nfun\n' });
    const fake = fakeAgentCli(ws, WRITE_OUTPUT);
    const ctx = createContext({ cwd: root, env: { ...ws.env, ...fake.env }, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const id = await startAgentJob(ctx, { role: 'content', game: 'g', input: join(root, 'records/loops/r1/content-input-1.md'), agent: { cli: 'codex', model: 'gpt-x', effort: 'low' } });
    expect((await ogw(ws, ['agent', 'wait', id, '--timeout', '60000'], { env: fake.env })).code).toBe(0);
    // Codex: no session option
    expect(fake.calls()[0]?.argv).toEqual(['exec', '--model', 'gpt-x', '-c', 'model_reasoning_effort="low"', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json', '-']);
    expect((await readJob(id, ws.env)).meta).toMatchObject({ agent: { cli: 'codex', model: 'gpt-x', effort: 'low' }, session: null });
  });

  it('starts the CLI in the game checkout with the prompt, and writes the run log in the jobs folder, not the checkout', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'records/loops/r1/content-input-1.md': '## request\nnone\n' });
    const before = sh(root, 'git', ['rev-parse', 'loop/r1']);
    const fake = fakeAgentCli(ws, `try { ${RUN_OGW} } catch {} ${WRITE_OUTPUT}`);
    const input = join(root, 'records/loops/r1/content-input-1.md');
    const { id, waited } = await runAgent(ws, ['content', '--game', 'g', '--input', input], fake.env, root);
    const output = join(root, 'records/loops/r1/content-1.md');
    expect(waited).toMatchObject({ code: 0, stdout: `${output}\n` });
    const [call] = fake.calls();
    // a new Claude Code session with the id kept in the job
    expect(call?.argv.slice(0, 10)).toEqual(['-p', '--model', 'claude-opus-5-5', '--effort', 'high', '--permission-mode', 'bypassPermissions', '--output-format', 'json', '--session-id']);
    expect(call?.argv[10]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(call?.argv).toHaveLength(11);
    expect(call?.cwd).toBe(root);
    expect(call?.prompt).toContain('## purpose');
    expect(call?.prompt).toContain(`- input: ${input}\n- output: ${output}\n- run: r1\n- iteration: 1\n`);
    expect(await readRunLog(ws, id)).toEqual({ runs: [{ command: 'ogw job status nojob', startedAt: expect.any(Number) as number, exitCode: 1, summary: null }], usage: noUsage('claude-opus-5-5', 'high') });
    const jobs = await jobsDir(ws.env);
    const job = await readJob(id, ws.env);
    expect(job.meta).toMatchObject({ role: 'content', output, runLog: join(jobs, 'run-logs', `${id}.json`), game: 'g', run: 'r1', iteration: 1 });
    // the checkout has only the result file the agent wrote: no run log, no commit
    expect(sh(root, 'git', ['rev-parse', 'loop/r1'])).toBe(before);
    expect(sh(root, 'git', ['status', '--porcelain', '--untracked-files=all'])).toBe('?? records/loops/r1/content-1.md\n');
    expect(typeof job.meta.cliPid).toBe('number');
    expect(typeof job.meta.cliPidStartedAt).toBe('string');
    expect(await ogw(ws, ['agent', 'status', id])).toMatchObject({ code: 0, stdout: 'done\n' });
    expect([`${id}.cli.log`, `${id}.stdout`, `${id}.stderr`].map((name) => existsSync(join(jobs, 'agent-logs', name)))).toEqual([true, true, true]);
    expect(existsSync(join(jobs, `${id}.stdout`))).toBe(false);
  });

  it('commits after the agent CLI with no fsmonitor or hook the agent set in git config, as the identity from before the CLI', async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.root, 'core-input.md'), 'command: create server core\n- module: routing\n');
    const globalConfig = join(ws.root, 'gitconfig');
    writeFileSync(globalConfig, '[user]\n\tname = Global Person\n\temail = global@example.com\n');
    const marks = join(ws.root, 'marks');
    const hooks = join(ws.root, 'agent-hooks');
    mkdirSync(hooks);
    const script = (name: string): string => `#!/bin/sh\nmkdir -p "${marks}"; touch "${join(marks, name)}"\n`;
    for (const name of ['fsmonitor-global', 'fsmonitor-local', 'post-commit']) writeFileSync(join(hooks, name), script(name), { mode: 0o755 });
    const behavior = [
      // the agent changes the git config that the job's own git calls after the CLI would read
      `execFileSync('git', ['config', 'core.fsmonitor', ${JSON.stringify(join(hooks, 'fsmonitor-local'))}]);`,
      `execFileSync('git', ['config', 'core.hooksPath', ${JSON.stringify(hooks)}]);`,
      `fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\\n\\tname = Agent\\n\\temail = agent@example.com\\n[core]\\n\\tfsmonitor = ${join(hooks, 'fsmonitor-global')}\\n');`,
      WRITE_OUTPUT,
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    const env = { ...fake.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined };
    const { id, waited } = await runAgent(ws, ['core', '--module', 'routing', '--input', join(ws.root, 'core-input.md')], env);
    expect(waited.code).toBe(0);
    expect(sh(ws.coreImpl, 'git', ['log', '-1', '--format=%an <%ae> %cn <%ce> %s', `agent/${id}`])).toMatch(/^Global Person <global@example\.com> Global Person <global@example\.com> ogw agent \w+: result file\n$/);
    expect(existsSync(marks)).toBe(false);
  });

  it('writes a command started with --background as its job, with the exit code when the job ends', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'in.md': 'x' });
    const behavior = [
      `const job = execFileSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(cliEntry())}, 'check', 'nogame', '--background'], { encoding: 'utf8' }).trim();`,
      'for (let i = 0; i < 300; i++) {',
      "  const entry = JSON.parse(fs.readFileSync(runLog, 'utf8')).runs.find((e) => e.job === job);",
      '  if (entry && entry.exitCode !== null) break;',
      '  await new Promise((r) => setTimeout(r, 100));',
      '}',
      "fs.writeFileSync(output, job);",
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    const { id, waited } = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'in.md')], fake.env, root);
    expect(waited.code).toBe(0);
    const job = readFileSync(join(root, 'records/loops/r1/content-1.md'), 'utf8');
    expect(await readRunLog(ws, id)).toEqual({ runs: [{ command: 'ogw check nogame', startedAt: expect.any(Number) as number, exitCode: 1, summary: null, job }], usage: noUsage('claude-opus-5-5', 'high') });
  });

  it('fails without a result file and reports why', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'in.md': 'x' });
    const fake = fakeAgentCli(ws, "console.log('agent says hi'); process.exitCode = 0;");
    const { id, waited } = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'in.md')], fake.env, root);
    expect(waited.code).toBe(1);
    expect(waited.stdout).toContain('failed\nfailed: the agent left no result file\noutput: none\nagent says hi');
    expect((await ogw(ws, ['agent', 'status', id])).stdout).toBe('failed\n');
  });

  it('reports the CLI exit code', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'in.md': 'x' });
    const fake = fakeAgentCli(ws, `${WRITE_OUTPUT} process.exitCode = 3;`);
    const { id, waited } = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'in.md')], fake.env, root);
    expect(waited.code).toBe(1);
    expect(waited.stdout).toContain(`failed: agent CLI ended with code 3\noutput: ${join(root, 'records/loops/r1/content-1.md')}`);
    expect((await ogw(ws, ['agent', 'status', id, '--json'])).stdout).toContain('"status": "failed"');
  });

  it('records the usage that Claude Code printed in the job record and the run log', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'in.md': 'x' });
    const fake = fakeAgentCli(ws, `process.stdout.write(fs.readFileSync(${JSON.stringify(usageFixture('claude-result.json'))}, 'utf8')); ${WRITE_OUTPUT}`);
    const { id, waited } = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'in.md')], fake.env, root);
    expect(waited.code).toBe(0);
    const usage = { cli: 'claude-code', model: 'claude-opus-5-5', effort: 'high', inputTokens: 31898, cachedTokens: 22611, outputTokens: 63, costUsd: 0.0211411, turns: 1 };
    const { meta } = await readJob(id, ws.env);
    expect(meta.usage).toEqual(usage);
    // a new session: the session totals are those of the job
    expect(meta.sessionUsage).toEqual({ inputTokens: 31898, cachedTokens: 22611, outputTokens: 63, costUsd: 0.0211411 });
    expect(await readRunLog(ws, id)).toEqual({ runs: [], usage });
  });

  it('records null usage for a CLI that printed none, and the job does not fail for it', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'in.md': 'x' });
    const fake = fakeAgentCli(ws, `console.log('plain text, no JSON'); ${WRITE_OUTPUT}`);
    const { id, waited } = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'in.md')], fake.env, root);
    expect(waited).toMatchObject({ code: 0, stdout: `${join(root, 'records/loops/r1/content-1.md')}\n` });
    expect(await ogw(ws, ['agent', 'status', id])).toMatchObject({ code: 0, stdout: 'done\n' });
    const { meta } = await readJob(id, ws.env);
    expect(meta.usage).toEqual(noUsage('claude-opus-5-5', 'high'));
    expect(meta.sessionUsage).toBeUndefined();
    expect(await readRunLog(ws, id)).toEqual({ runs: [], usage: noUsage('claude-opus-5-5', 'high') });
  });

  it('records the tokens that Codex printed, with no cost and no turn count', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'in.md': 'x' });
    const fake = fakeAgentCli(ws, `process.stderr.write('Reading additional input from stdin...\\n'); process.stdout.write(fs.readFileSync(${JSON.stringify(usageFixture('codex-command.jsonl'))}, 'utf8')); ${WRITE_OUTPUT}`);
    const ctx = createContext({ cwd: root, env: { ...ws.env, ...fake.env }, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const id = await startAgentJob(ctx, { role: 'content', game: 'g', input: join(root, 'in.md'), agent: { cli: 'codex', model: 'gpt-x', effort: 'low' } });
    expect((await ogw(ws, ['agent', 'wait', id, '--timeout', '60000'], { env: fake.env })).code).toBe(0);
    const usage = { cli: 'codex', model: 'gpt-x', effort: 'low', inputTokens: 33201, cachedTokens: 23552, outputTokens: 51, costUsd: null, turns: null };
    expect((await readJob(id, ws.env)).meta).toMatchObject({ usage, session: null });
    expect((await readJob(id, ws.env)).meta.sessionUsage).toBeUndefined();
    expect(await readRunLog(ws, id)).toEqual({ runs: [], usage });
  });

  it('records the usage of a content agent that continues a session as the session totals minus those of the job before', async () => {
    const ws = makeWorkspace();
    const inputs = Object.fromEntries([1, 2].map((n) => [`records/loops/r1/content-input-${String(n)}.md`, '## kind\nfun\n']));
    const { root, game } = await gameWithRun(ws, inputs, { data: { loop: { kinds: [1, 2].map((iteration) => ({ iteration, kind: 'fun' })) } } });
    // the fake Claude Code keeps the session file, and prints the result object of a new session or of the resumed one
    const behavior = [
      "const at = process.argv.indexOf('--session-id');",
      "if (at > 0) { const dir = process.env.CLAUDE_CONFIG_DIR + '/projects/-games-g'; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dir + '/' + process.argv[at + 1] + '.jsonl', '{}\\n'); }",
      `const printed = process.argv.includes('--resume') ? ${JSON.stringify(usageFixture('claude-session-resumed.json'))} : ${JSON.stringify(usageFixture('claude-session-new.json'))};`,
      "process.stdout.write(fs.readFileSync(printed, 'utf8'));",
      WRITE_OUTPUT,
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    const iterate = async (n: number): Promise<string> => {
      await changeRuns(game, (runs) => {
        (runs[0] as { iteration: number }).iteration = n;
      });
      const { id, waited } = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, `records/loops/r1/content-input-${String(n)}.md`)], fake.env, root);
      expect(waited.code).toBe(0);
      return id;
    };
    const first = await iterate(1);
    const second = await iterate(2);
    expect(fake.calls().at(-1)?.argv).toContain('--resume');
    expect((await readJob(first, ws.env)).meta.usage).toMatchObject({ inputTokens: 31228, cachedTokens: 26720, outputTokens: 63, costUsd: 0.011994000000000001, turns: 1 });
    const { meta } = await readJob(second, ws.env);
    expect(meta.usage).toMatchObject({ inputTokens: 63305 - 31228, cachedTokens: 57939 - 26720, outputTokens: 112 - 63, turns: 1 });
    expect((meta.usage as { costUsd: number }).costUsd).toBeCloseTo(0.0170679 - 0.011994, 10);
    expect(meta.sessionUsage).toEqual({ inputTokens: 63305, cachedTokens: 57939, outputTokens: 112, costUsd: 0.0170679 });
  });

  it('shows the result object of Claude Code as its result text in the failure content', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'in.md': 'x' });
    const fake = fakeAgentCli(ws, `process.stdout.write(fs.readFileSync(${JSON.stringify(usageFixture('claude-result.json'))}, 'utf8'));`);
    const { id, waited } = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'in.md')], fake.env, root);
    expect(waited.code).toBe(1);
    expect(waited.stdout).toContain("failed: the agent left no result file\noutput: none\nOk, I'm ready to help! What would you like to work on?");
    expect(waited.stdout).not.toContain('modelUsage');
    // the CLI log keeps the result object as the CLI printed it
    expect(readFileSync(join(await jobsDir(ws.env), 'agent-logs', `${id}.cli.log`), 'utf8')).toContain('"modelUsage"');
    expect((await readJob(id, ws.env)).meta.usage).toMatchObject({ inputTokens: 31898, costUsd: 0.0211411 });
  });

  it('runs in the foreground without --background and prints the result path', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'in.md': 'x' });
    const fake = fakeAgentCli(ws, WRITE_OUTPUT);
    const run = await ogw(ws, ['agent', 'content', '--game', 'g', '--input', 'in.md'], { env: fake.env, cwd: root });
    expect(run).toMatchObject({ code: 0, stdout: `${join(root, 'records/loops/r1/content-1.md')}\n` });
  });
});

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('ogw agent: the other games', () => {
  it('a content agent and what it starts use its game and core worktrees, and neither reads nor changes the other game repos and worktrees', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'own.txt': 'own', 'records/loops/r1/content-input-1.md': '## request\nnone\n' });
    const other = makeGame(ws, 'other', { 'settings.json': {}, 'secret.txt': 'hidden' });
    const file = (folder: string): string => {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'a.txt'), 'a');
      return join(folder, 'a.txt');
    };
    const paths = {
      own: join(root, 'own.txt'),
      ownWorktree: file(join(ws.worktrees, 'g', 'agent-1')),
      core: file(join(ws.worktrees, '_core', 'agent-2')),
      other: join(other, 'secret.txt'),
      otherWorktree: file(join(ws.worktrees, 'other', 'agent-3')),
    };
    const behavior = [
      `const paths = ${JSON.stringify(paths)};`,
      "const open = (f) => { try { f(); return true; } catch { return false; } };",
      'const result = {};',
      `result.otherFolder = open(() => { if (fs.readdirSync(${JSON.stringify(other)}).length === 0) throw new Error('empty'); });`,
      'for (const [name, path] of Object.entries(paths)) {',
      '  result[name] = { read: open(() => fs.readFileSync(path)), child: open(() => execFileSync(\'/bin/cat\', [path], { stdio: \'ignore\' })) };',
      '  open(() => fs.appendFileSync(path, \'x\'));',
      '}',
      'fs.writeFileSync(output, JSON.stringify(result));',
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    const { waited } = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'records/loops/r1/content-input-1.md')], fake.env, root);
    expect(waited.code).toBe(0);
    const all = { read: true, child: true };
    const none = { read: false, child: false };
    expect(JSON.parse(readFileSync(join(root, 'records/loops/r1/content-1.md'), 'utf8'))).toEqual({
      own: all,
      ownWorktree: all,
      core: all,
      other: none,
      otherWorktree: none,
      otherFolder: false,
    });
    expect(readFileSync(paths.own, 'utf8')).toBe('ownx');
    expect(readFileSync(paths.other, 'utf8')).toBe('hidden');
    expect(readFileSync(paths.otherWorktree, 'utf8')).toBe('a');
    expect(fake.calls()[0]?.argv).toContain('--session-id');
  });

  it('wraps the roles of one game that run no local model when another game exists, and no other role or a game alone', async () => {
    const ws = makeWorkspace();
    makeGame(ws, 'g', { 'settings.json': {} });
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const workspace = await ctx.workspace();
    const agent: AgentSettings = { cli: 'claude-code', model: 'm', effort: 'high' };
    const run = (role: string, game: string | null) => cliToRun(ctx, role, agent, workspace, null, null, null, game);
    expect(await run('content', 'g')).toMatchObject({ profileFolder: null, command: { cmd: 'claude' } });
    makeGame(ws, 'other', { 'settings.json': {} });
    for (const role of ['content', 'translation', 'server-hardening', 'client-hardening']) {
      const wrapped = await run(role, 'g');
      expect(wrapped.command.cmd).toBe(process.platform === 'darwin' ? 'sandbox-exec' : 'bwrap');
      expect(readFileSync(join(wrapped.profileFolder as string, 'sandbox.sb'), 'utf8')).toContain(join(ws.games, 'other'));
      expect(readFileSync(join(wrapped.profileFolder as string, 'sandbox.sb'), 'utf8')).not.toContain(join(ws.games, 'g'));
    }
    // `resource` runs local models in their own sandbox, which macOS does not start inside another
    expect(await run('resource', 'g')).toMatchObject({ profileFolder: null, command: { cmd: 'claude' } });
    for (const role of ['core', 'review']) expect(await run(role, null)).toMatchObject({ profileFolder: null, command: { cmd: 'claude' } });
  });

  it('runs on Linux with the other games on an empty mount and the host processes in view, and starts without it where no sandbox runs', async () => {
    const ws = makeWorkspace();
    makeGame(ws, 'g', { 'settings.json': {} });
    makeGame(ws, 'other', { 'settings.json': {} });
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const workspace = await ctx.workspace();
    const agent: AgentSettings = { cli: 'claude-code', model: 'm', effort: 'high' };
    const real = process.platform;
    const on = async (platform: NodeJS.Platform) => {
      Object.defineProperty(process, 'platform', { value: platform });
      try {
        return await cliToRun(ctx, 'content', agent, workspace, null, null, null, 'g');
      } finally {
        Object.defineProperty(process, 'platform', { value: real });
      }
    };
    const linux = await on('linux');
    expect(linux.command.cmd).toBe('bwrap');
    expect(linux.command.args.slice(0, 5)).toEqual(['--dev-bind', '/', '/', '--tmpfs', realpathSync(join(ws.games, 'other'))]);
    expect(linux.command.args).not.toContain('--unshare-pid');
    expect(await on('win32')).toMatchObject({ profileFolder: null, command: { cmd: 'claude' } });
  });
});

describe('otherGameFolders', () => {
  it('lists the folders of the other games, not its own, core worktrees or files, and nothing for a missing folder', async () => {
    const ws = makeWorkspace();
    const dirs = [join(ws.games, 'g'), join(ws.games, 'other'), join(ws.worktrees, 'g'), join(ws.worktrees, 'other'), join(ws.worktrees, '_core')];
    for (const dir of dirs) mkdirSync(dir, { recursive: true });
    writeFileSync(join(ws.games, '.DS_Store'), '');
    const folders = { harness: ws.harness, coreImpl: ws.coreImpl, coreReleases: ws.coreReleases, games: ws.games, worktrees: ws.worktrees };
    expect(await otherGameFolders(folders, 'g')).toEqual([join(ws.games, 'other'), join(ws.worktrees, 'other')]);
    expect(await otherGameFolders({ ...folders, games: join(ws.root, 'none'), worktrees: join(ws.root, 'none') }, 'g')).toEqual([]);
  });
});

describe('ogw agent: request checks', () => {
  it('fails before starting anything', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'in.md': 'x' });
    const cases: [string[], string][] = [
      [['nobody', '--game', 'g', '--input', 'in.md'], 'unknown role: nobody'],
      [['content', '--input', 'in.md'], '--game is required for role content'],
      [['core', '--game', 'g', '--input', 'in.md'], '--game is not given to role core'],
      [['content', '--game', 'g', '--module', 'x', '--input', 'in.md'], '--module is given only to role core'],
      [['core', '--module', 'testing,storage', '--input', 'in.md'], 'unknown module: testing,storage (--module takes module and tool names, separated by spaces)'],
      [['content', '--game', 'g', '--input', 'missing.md'], 'input file not found'],
      [['content', '--game', 'g'], 'usage: ogw agent'],
    ];
    for (const [argv, message] of cases) {
      const run = await ogw(ws, ['agent', ...argv], { cwd: root });
      expect(run.code, argv.join(' ')).toBe(1);
      expect(run.stderr).toContain(message);
    }
  });

  it('needs an open run for game roles', async () => {
    const ws = makeWorkspace();
    const { root, game } = await gameWithRun(ws, { 'in.md': 'x' });
    const { changeRuns } = await import('../../../src/lib/runstate.ts');
    await changeRuns(game, (runs) => {
      for (const run of runs) run.closedAt = Date.now();
    });
    const run = await ogw(ws, ['agent', 'content', '--game', 'g', '--input', 'in.md'], { cwd: root });
    expect(run.stderr).toContain('no open run for game g');
  });
});

describe('ogw agent: worktree roles', () => {
  it('runs resource in a worktree of the branch and writes the result next to the request', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'records/loops/r1/resource-requests/hero.md': '## keys\n' });
    const fake = fakeAgentCli(ws, WRITE_OUTPUT);
    const { id, waited } = await runAgent(ws, ['resource', '--game', 'g', '--input', join(root, 'records/loops/r1/resource-requests/hero.md')], fake.env, root);
    const worktree = join(ws.worktrees, 'g', `agent-${id}`);
    expect(waited.stdout).toBe(`${join(worktree, 'records/loops/r1/resource-requests/hero-result.md')}\n`);
    expect(fake.calls()[0]?.cwd).toBe(worktree);
    expect(sh(worktree, 'git', ['branch', '--show-current']).trim()).toBe(`agent/${id}`);
    expect(await readRunLog(ws, id)).toEqual({ runs: [], usage: noUsage('claude-opus-5-5', 'high') });
    // the agent committed nothing, and neither did `ogw agent`
    expect(sh(root, 'git', ['rev-parse', `agent/${id}`])).toBe(sh(root, 'git', ['rev-parse', 'loop/r1']));
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('links the reference videos of the checkout, which git does not hold, into the worktree', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, {
      '.gitignore': '/records/setup/reference/*\n!/records/setup/reference/reference.md\n',
      'records/setup/reference/reference.md': '## game\nx\n',
      'records/loops/r1/resource-requests/hero.md': '## keys\n',
    });
    writeFileSync(join(root, 'records/setup/reference/clip.mp4'), 'video');
    const fake = fakeAgentCli(ws, WRITE_OUTPUT);
    const { id } = await runAgent(ws, ['resource', '--game', 'g', '--input', join(root, 'records/loops/r1/resource-requests/hero.md')], fake.env, root);
    const reference = join(ws.worktrees, 'g', `agent-${id}`, 'records/setup/reference');
    expect(lstatSync(join(reference, 'clip.mp4')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(reference, 'clip.mp4'), 'utf8')).toBe('video');
    expect(lstatSync(join(reference, 'reference.md')).isSymbolicLink()).toBe(false);
    // git ignores the links as it ignores the videos
    expect(sh(join(ws.worktrees, 'g', `agent-${id}`), 'git', ['status', '--porcelain', '--untracked-files=all'])).not.toContain('records/setup/reference');
  });

  it('fails for a resource request outside the game repo', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws);
    writeFileSync(join(ws.root, 'outside.md'), 'x');
    const run = await ogw(ws, ['agent', 'resource', '--game', 'g', '--input', join(ws.root, 'outside.md')], { cwd: root });
    expect(run.stderr).toContain('resource request file is not inside');
  });

  it('names the translation result by language and counts the translated rows in the run log', async () => {
    const ws = makeWorkspace();
    const head = 'key,source,source_hash,current_hash,text\n';
    const { root } = await gameWithRun(ws, {
      'records/loops/r1/translation-input-ko-123.md': 'ko\n',
      'data/translations/ko.csv': `${head}a,A,,h,\nb,B,,h,\n`,
      'data/glossary.csv': 'source,id_name,note,source_hash,ko\nSword,[sword],,s,\n',
    });
    const fake = fakeAgentCli(
      ws,
      [
        `fs.writeFileSync('data/translations/ko.csv', ${JSON.stringify(`${head}a,A,h,h,에이\nb,B,h,h,비\n`)});`,
        "fs.writeFileSync('data/glossary.csv', 'source,id_name,note,source_hash,ko\\nSword,[sword],,s,검\\n');",
        "execFileSync('git', ['commit', '-qam', 'ko']);",
        WRITE_OUTPUT,
      ].join('\n'),
    );
    const { id, waited } = await runAgent(ws, ['translation', '--game', 'g', '--input', join(root, 'records/loops/r1/translation-input-ko-123.md')], fake.env, root);
    const worktree = join(ws.worktrees, 'g', `agent-${id}`);
    expect(waited.stdout).toBe(`${join(worktree, 'records/loops/r1/translation-ko-123.md')}\n`);
    expect(await readRunLog(ws, id)).toEqual({ runs: [], translation: { ko: { text: 2, glossary: 1 } }, usage: noUsage('claude-sonnet-5-5', 'medium') });
  });

  it('reads the translation counts with git that reads no global config the agent wrote', async () => {
    const ws = makeWorkspace();
    const head = 'key,source,source_hash,current_hash,text\n';
    const { root } = await gameWithRun(ws, { 'records/loops/r1/translation-input-ko-1.md': 'ko\n', 'data/translations/ko.csv': `${head}a,A,,h,\n` });
    const globalConfig = join(ws.root, 'gitconfig');
    writeFileSync(globalConfig, '');
    // git that reads this global config writes each command it runs to the trace file
    const trace = join(ws.root, 'git-trace');
    const agentConfig = join(ws.root, 'agent-gitconfig');
    writeFileSync(agentConfig, `[trace2]\n\tnormalTarget = ${trace}\n`);
    const fake = fakeAgentCli(
      ws,
      [
        `fs.writeFileSync('data/translations/ko.csv', ${JSON.stringify(`${head}a,A,h,h,에이\n`)});`,
        "execFileSync('git', ['commit', '-qam', 'ko']);",
        `fs.copyFileSync(${JSON.stringify(agentConfig)}, ${JSON.stringify(globalConfig)});`,
        WRITE_OUTPUT,
      ].join('\n'),
    );
    const env = { ...fake.env, GIT_CONFIG_GLOBAL: globalConfig };
    const { id, waited } = await runAgent(ws, ['translation', '--game', 'g', '--input', join(root, 'records/loops/r1/translation-input-ko-1.md')], env, root);
    expect(waited.code).toBe(0);
    expect(await readRunLog(ws, id)).toEqual({ runs: [], translation: { ko: { text: 1, glossary: 0 } }, usage: noUsage('claude-sonnet-5-5', 'medium') });
    const traced = existsSync(trace) ? readFileSync(trace, 'utf8') : '';
    expect(traced).not.toMatch(/ls-tree|git show|rev-parse HEAD/);
  });

  it('leaves out the counts of a language whose CSV it cannot read, and still writes the run log and takes the result', async () => {
    const ws = makeWorkspace();
    const head = 'key,source,source_hash,current_hash,text\n';
    const { root } = await gameWithRun(ws, {
      'records/loops/r1/translation-input-ko-1.md': 'ko\n',
      'data/translations/ko.csv': `${head}a,A,,h,\n`,
      'data/translations/ja.csv': `${head}a,A,,h,\n`,
    });
    const fake = fakeAgentCli(
      ws,
      [
        `fs.writeFileSync('data/translations/ko.csv', ${JSON.stringify(`${head}a,A,h,h,"에이" 추가\n`)});`,
        `fs.writeFileSync('data/translations/ja.csv', ${JSON.stringify(`${head}a,A,h,h,エー\n`)});`,
        "execFileSync('git', ['commit', '-qam', 'ko']);",
        WRITE_OUTPUT,
      ].join('\n'),
    );
    const { id, waited } = await runAgent(ws, ['translation', '--game', 'g', '--input', join(root, 'records/loops/r1/translation-input-ko-1.md')], fake.env, root);
    const worktree = join(ws.worktrees, 'g', `agent-${id}`);
    expect(waited).toMatchObject({ code: 0, stdout: `${join(worktree, 'records/loops/r1/translation-ko-1.md')}\n` });
    expect(await readRunLog(ws, id)).toEqual({ runs: [], translation: { ja: { text: 1, glossary: 0 } }, usage: noUsage('claude-sonnet-5-5', 'medium') });
  });

  it('rejects a translation input that does not hold one language', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'tr.md': 'ko and ja\n', 'tr2.md': 'ko\nja\n' });
    const run = await ogw(ws, ['agent', 'translation', '--game', 'g', '--input', 'tr.md'], { cwd: root });
    expect(run.stderr).toContain('does not hold one language');
    const lines = await ogw(ws, ['agent', 'translation', '--game', 'g', '--input', 'tr2.md'], { cwd: root });
    expect(lines.stderr).toContain('does not hold one language');
  });

  it('numbers hardening records by round in the build branch, with the lower-case environment the readers use', async () => {
    const ws = makeWorkspace();
    const records = {
      'records/hardening/dev-1.0.0-server-1.md': 'r1',
      'records/hardening/dev-1.0.0-client-1.md': 'c1',
      'records/hardening/dev-1.0.0-client-2.md': 'c2',
      'records/hardening/stg-1.0.0-server-4.md': 'other env',
      'records/hardening/dev-1.0.1-server-5.md': 'other version',
    };
    const { root, game } = await gameWithRun(ws, { 'in.md': 'x', ...records }, { kind: 'build', env: 'DEV', version: '1.0.0', branch: 'build/dev-1.0.0' });
    const fake = fakeAgentCli(ws, WRITE_OUTPUT);
    const { id, waited } = await runAgent(ws, ['server-hardening', '--game', 'g', '--input', join(root, 'in.md')], fake.env, root);
    const worktree = join(ws.worktrees, 'g', `agent-${id}`);
    expect(waited.stdout).toBe(`${join(worktree, 'records/hardening/dev-1.0.0-server-2.md')}\n`);
    // `ogw loop findings --hardening` reads the record the agent wrote as this round's
    const run = await requireOpenRun(game);
    expect(await hardeningRecords({ ...game, root: worktree }, run)).toEqual({
      round: 2,
      records: ['records/hardening/dev-1.0.0-client-2.md', 'records/hardening/dev-1.0.0-server-2.md'],
    });
  });

  it('runs hardening only in a build run', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'in.md': 'x' });
    const run = await ogw(ws, ['agent', 'client-hardening', '--game', 'g', '--input', 'in.md'], { cwd: root });
    expect(run.stderr).toContain('role client-hardening runs only in a build run');
  });
});

describe('ogw agent: core and review', () => {
  it('runs core in a open-game-works-core-impl worktree from main, records modules, installs the pre-commit hook', async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.root, 'core-input.md'), 'command: create server core\n- module: routing\n');
    const fake = fakeAgentCli(ws, `${WRITE_OUTPUT} execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'w', '--no-verify']);`);
    const { id, waited } = await runAgent(ws, ['core', '--module', 'routing', 'auth', '--input', join(ws.root, 'core-input.md')], fake.env);
    const worktree = join(ws.worktrees, '_core', `agent-${id}`);
    expect(waited.stdout).toMatch(new RegExp(`^${worktree}/records/\\d+-create-server-core-${id}\\.md\\n$`));
    expect(fake.calls()[0]?.prompt).not.toContain('- run:');
    expect((await readJob(id, ws.env)).meta).toMatchObject({ modules: ['routing', 'auth'], branch: `agent/${id}`, worktree });
    const hook = readFileSync(join(ws.coreImpl, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(hook).toContain('meta sync core --staged');
    // the hook syncs in the workspace of this harness, not of whatever harness a commit's environment names
    expect(hook).toContain(`OGW_HARNESS_ROOT="${ws.harness}"`);
    // it runs the ogw wrapper, which finds node in PATH, not this node binary, which a node upgrade can remove
    expect(hook).not.toContain(process.execPath);
    expect(hook).toContain(`"${join(dirname(cliEntry()), '..', 'bin', 'ogw')}" meta sync core --staged`);
  });

  it('adds the hook command to an existing pre-commit hook once', async () => {
    const ws = makeWorkspace();
    const { ensurePreCommitHook } = await import('../../../src/commands/agent/lib/launch.ts');
    mkdirSync(join(ws.coreImpl, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(ws.coreImpl, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho mine\n');
    await ensurePreCommitHook(ws.coreImpl, ws.env);
    await ensurePreCommitHook(ws.coreImpl, ws.env);
    const hook = readFileSync(join(ws.coreImpl, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(hook.split('\n')[0]).toBe('#!/bin/sh');
    expect(hook.match(/meta sync core --staged/g)?.length).toBe(1);
    expect(hook).toContain('echo mine');
  });

  it('runs the core pre-commit hook in the workspace of its harness when the commit names no harness', async () => {
    const ws = makeWorkspace();
    const { ensurePreCommitHook } = await import('../../../src/commands/agent/lib/launch.ts');
    await ensurePreCommitHook(ws.coreImpl, ws.env);
    writeFileSync(join(ws.coreImpl, 'x.txt'), 'x');
    // no OGW_HARNESS_ROOT
    const env = { ...gitEnv, PATH: process.env.PATH };
    execFileSync('git', ['add', 'x.txt'], { cwd: ws.coreImpl, env });
    // git gives the hook's output to stderr
    const commit = spawnSync('git', ['commit', '-m', 'x'], { cwd: ws.coreImpl, env, encoding: 'utf8' });
    expect(commit).toMatchObject({ status: 0 });
    expect(commit.stderr).toContain('no staged engine resource');
    expect(sh(ws.coreImpl, 'git', ['log', '-1', '--format=%s'])).toBe('x\n');
  });

  it('commits the core review file in the worktree', async () => {
    const ws = makeWorkspace();
    const input = join(ws.root, 'review-input.md');
    writeFileSync(input, formatReviewInput({ side: 'core', target: 'routing', round: 2, definitions: [], previousReview: null, commitRange: null, coreReports: [] }));
    const fake = fakeAgentCli(ws, WRITE_OUTPUT);
    const { id, waited } = await runAgent(ws, ['review', '--input', input], fake.env);
    const worktree = join(ws.worktrees, '_core', `agent-${id}`);
    expect(waited.stdout).toBe(`${join(worktree, 'records/review/routing-2.md')}\n`);
    expect(log(worktree, `agent/${id}`, 'records/review/routing-2.md')).toBe('result\n');
  });

  it('runs a tool review in a temporary harness worktree and writes the review file outside it', async () => {
    const ws = makeWorkspace();
    const input = join(ws.root, 'review-input.md');
    writeFileSync(input, formatReviewInput({ side: 'tool', target: 'agent merge', round: 1, definitions: [], previousReview: null, commitRange: null, coreReports: [] }));
    const fake = fakeAgentCli(ws, `fs.writeFileSync(output, (fs.existsSync('AGENTS.md') ? 'saw harness ' : 'no harness ') + (fs.statSync('.').mode & 0o777).toString(8));`);
    const { id, waited } = await runAgent(ws, ['review', '--input', input], fake.env);
    const output = waited.stdout.trim();
    expect(output.endsWith('/agent-merge-1.md')).toBe(true);
    expect(readFileSync(output, 'utf8')).toBe('saw harness 700');
    const cwd = fake.calls()[0]?.cwd as string;
    // the worktree and the review file folder are owner-only folders in the temp folder of ogw, which the sandboxes block
    const temp = await privateTempDir(ws.env);
    expect(cwd.startsWith(join(temp, 'ogw-tool-review-'))).toBe(true);
    expect(dirname(output).startsWith(join(temp, 'ogw-review-file-'))).toBe(true);
    expect(statSync(dirname(output)).mode & 0o777).toBe(0o700);
    expect(statSync(temp).mode & 0o777).toBe(0o700);
    expect(existsSync(cwd)).toBe(false);
    expect(sh(ws.harness, 'git', ['worktree', 'list'])).not.toContain(cwd);
    expect((await readJob(id, ws.env)).meta.worktree).toBeNull();
  });
});

describe('ogw agent: no folder left after a failure', () => {
  /** The agents of the test harness settings without `role`. */
  function agentsWithout(role: string): Record<string, unknown> {
    const agents = testSettings().agents as Record<string, unknown>;
    return Object.fromEntries(Object.entries(agents).filter(([name]) => name !== role));
  }

  function agentFolders(temp: string, role: string): string[] {
    return readdirSync(temp).filter((name) => name.startsWith(`ogw-${role}-`));
  }

  it('removes the judge folder when a path field of the input names no file', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n' });
    const temp = join(ws.root, 'os-temp');
    mkdirSync(temp);
    const input = join(ws.root, 'judge.json');
    writeFileSync(input, JSON.stringify({ A: { instance: 'a', playGuide: join(root, 'play-guide.md') }, B: { instance: 'b', playGuide: join(root, 'nothing.md') } }));
    const run = await ogw(ws, ['agent', 'judge', '--game', 'g', '--input', input], { cwd: root, env: { TMPDIR: temp } });
    expect(run).toMatchObject({ code: 1 });
    expect(run.stderr).toContain('B.playGuide: file not found');
    expect(agentFolders(temp, 'judge')).toEqual([]);
  });

  it('removes the play folder when the job fails before the agent CLI starts', async () => {
    const ws = makeWorkspace({ agents: agentsWithout('play') });
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n' });
    const temp = join(ws.root, 'os-temp');
    mkdirSync(temp);
    const input = join(ws.root, 'play.json');
    writeFileSync(input, JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null }));
    const { waited } = await runAgent(ws, ['play', '--game', 'g', '--input', input], { TMPDIR: temp }, root);
    expect(waited.code).not.toBe(0);
    expect(waited.stdout + waited.stderr).toContain('agents.play is missing');
    expect(agentFolders(temp, 'play')).toEqual([]);
  });

  it('removes the tool review worktree when the job fails before the agent CLI starts', async () => {
    const ws = makeWorkspace({ agents: agentsWithout('review') });
    const input = join(ws.root, 'review-input.md');
    writeFileSync(input, formatReviewInput({ side: 'tool', target: 'agent merge', round: 1, definitions: [], previousReview: null, commitRange: null, coreReports: [] }));
    const worktreesBefore = sh(ws.harness, 'git', ['worktree', 'list']);
    const { waited } = await runAgent(ws, ['review', '--input', input], {});
    expect(waited.code).not.toBe(0);
    expect(waited.stdout + waited.stderr).toContain('agents.review is missing');
    expect(sh(ws.harness, 'git', ['worktree', 'list'])).toBe(worktreesBefore);
    expect(readdirSync(await privateTempDir(ws.env)).filter((name) => name.startsWith('ogw-tool-review-'))).toEqual([]);
  });
});

describe('ogw agent wait', () => {
  it('prints running and ends with 75 on timeout', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'in.md': 'x' });
    const fake = fakeAgentCli(ws, `${WRITE_OUTPUT} await new Promise((r) => setTimeout(r, 4000));`);
    const started = await ogw(ws, ['agent', 'content', '--game', 'g', '--input', 'in.md', '--background'], { env: fake.env, cwd: root });
    const id = started.stdout.trim();
    expect(await ogw(ws, ['agent', 'wait', id, '--timeout', '100'])).toMatchObject({ code: 75, stdout: 'running\n' });
    expect((await ogw(ws, ['agent', 'status', id])).stdout).toBe('running\n');
    expect((await ogw(ws, ['agent', 'wait', id, '--timeout', '30000'])).code).toBe(0);
    commitAll(root);
  });

  it('fails for a job that is not an agent job', async () => {
    const ws = makeWorkspace();
    expect((await ogw(ws, ['agent', 'status', 'zzz'])).stderr).toContain('job not found: zzz');
  });
});
