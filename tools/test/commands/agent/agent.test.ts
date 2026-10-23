import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hardeningRecords } from '../../../src/commands/loop/lib/findings.ts';
import { formatReviewInput } from '../../../src/commands/review/lib/input.ts';
import { instancesDir, playAccessDir } from '../../../src/commands/instance/lib/records.ts';
import { jobsDir, readJob } from '../../../src/lib/jobs.ts';
import { requireOpenRun } from '../../../src/lib/runstate.ts';
import { cliEntry } from '../../../src/lib/paths.ts';
import { BROKER_RUN } from '../../../src/lib/broker-client.ts';
import { pidNamespace, processStartedAt } from '../../../src/lib/proc.ts';
import { writeJob } from '../job/helpers.ts';
import { privateTempDir } from '../../../src/lib/secret-files.ts';
import { newTempFolder } from '../../../src/commands/agent/lib/files.ts';
import { ogw, commitAll, makeWorkspace, sh, testSettings } from '../../helpers/workspace.ts';
import { fakeAgentCli, gameWithRun, runAgent, WRITE_OUTPUT } from './helpers.ts';

const RUN_OGW = `execFileSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(cliEntry())}, 'job', 'status', 'nojob'], { stdio: 'ignore' }) ;`;

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

  it('starts the CLI in the game checkout with the prompt, writes and commits the run log', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'records/loops/r1/content-input-1.md': '## request\nnone\n' });
    const fake = fakeAgentCli(ws, `try { ${RUN_OGW} } catch {} ${WRITE_OUTPUT}`);
    const input = join(root, 'records/loops/r1/content-input-1.md');
    const { id, waited } = await runAgent(ws, ['content', '--game', 'g', '--input', input], fake.env, root);
    const output = join(root, 'records/loops/r1/content-1.md');
    expect(waited).toMatchObject({ code: 0, stdout: `${output}\n` });
    const [call] = fake.calls();
    expect(call?.argv).toEqual(['-p', '--model', 'claude-opus-5-5', '--effort', 'high', '--permission-mode', 'bypassPermissions']);
    expect(call?.cwd).toBe(root);
    expect(call?.prompt).toContain('## purpose');
    expect(call?.prompt).toContain(`- input: ${input}\n- output: ${output}\n- run: r1\n- iteration: 1\n`);
    const runLog = JSON.parse(log(root, 'loop/r1', 'records/loops/r1/content-1-runs.json')) as { runs: { command: string; exitCode: number }[] };
    expect(runLog.runs).toEqual([{ command: 'ogw job status nojob', startedAt: expect.any(Number) as number, exitCode: 1, summary: null }]);
    const job = await readJob(id, ws.env);
    expect(job.meta).toMatchObject({ role: 'content', output, runLog: join(root, 'records/loops/r1/content-1-runs.json'), game: 'g', run: 'r1', iteration: 1 });
    expect(typeof job.meta.cliPid).toBe('number');
    expect(typeof job.meta.cliPidStartedAt).toBe('string');
    expect(await ogw(ws, ['agent', 'status', id])).toMatchObject({ code: 0, stdout: 'done\n' });
    const jobs = await jobsDir(ws.env);
    expect([`${id}.cli.log`, `${id}.stdout`, `${id}.stderr`].map((name) => existsSync(join(jobs, 'agent-logs', name)))).toEqual([true, true, true]);
    expect(existsSync(join(jobs, `${id}.stdout`))).toBe(false);
  });

  it('commits after the agent CLI with no fsmonitor or hook the agent set in git config, as the identity from before the CLI', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'records/loops/r1/content-input-1.md': '## request\nnone\n' });
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
    const input = join(root, 'records/loops/r1/content-input-1.md');
    const { waited } = await runAgent(ws, ['content', '--game', 'g', '--input', input], env, root);
    expect(waited.code).toBe(0);
    expect(sh(root, 'git', ['log', '-1', '--format=%an <%ae> %cn <%ce> %s', 'loop/r1'])).toMatch(/^Global Person <global@example\.com> Global Person <global@example\.com> ogw agent \w+: run log\n$/);
    expect(existsSync(marks)).toBe(false);
  });

  it('writes a command started with --background as its job, with the exit code when the job ends', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'in.md': 'x' });
    const behavior = [
      `const job = execFileSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(cliEntry())}, 'check', 'nogame', '--background'], { encoding: 'utf8' }).trim();`,
      "const runLog = output.replace(/\\.md$/, '-runs.json');",
      'for (let i = 0; i < 300; i++) {',
      "  const entry = JSON.parse(fs.readFileSync(runLog, 'utf8')).runs.find((e) => e.job === job);",
      '  if (entry && entry.exitCode !== null) break;',
      '  await new Promise((r) => setTimeout(r, 100));',
      '}',
      "fs.writeFileSync(output, job);",
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    const { waited } = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'in.md')], fake.env, root);
    expect(waited.code).toBe(0);
    const job = readFileSync(join(root, 'records/loops/r1/content-1.md'), 'utf8');
    const runLog = JSON.parse(log(root, 'loop/r1', 'records/loops/r1/content-1-runs.json')) as { runs: unknown[] };
    expect(runLog.runs).toEqual([{ command: 'ogw check nogame', startedAt: expect.any(Number) as number, exitCode: 1, summary: null, job }]);
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

  it('runs in the foreground without --background and prints the result path', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'in.md': 'x' });
    const fake = fakeAgentCli(ws, WRITE_OUTPUT);
    const run = await ogw(ws, ['agent', 'content', '--game', 'g', '--input', 'in.md'], { env: fake.env, cwd: root });
    expect(run).toMatchObject({ code: 0, stdout: `${join(root, 'records/loops/r1/content-1.md')}\n` });
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
    expect(log(worktree, `agent/${id}`, 'records/loops/r1/resource-requests/hero-result-runs.json')).toBe('{\n  "runs": []\n}\n');
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
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
    const runLog = JSON.parse(log(worktree, `agent/${id}`, 'records/loops/r1/translation-ko-123-runs.json')) as unknown;
    expect(runLog).toEqual({ runs: [], translation: { ko: { text: 2, glossary: 1 } } });
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
    const worktree = join(ws.worktrees, 'g', `agent-${id}`);
    expect(JSON.parse(log(worktree, `agent/${id}`, 'records/loops/r1/translation-ko-1-runs.json'))).toEqual({ runs: [], translation: { ko: { text: 1, glossary: 0 } } });
    const traced = existsSync(trace) ? readFileSync(trace, 'utf8') : '';
    expect(traced).not.toMatch(/ls-tree|git show|rev-parse HEAD/);
  });

  it('leaves out the counts of a language whose CSV it cannot read, and still commits the run log and takes the result', async () => {
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
    expect(JSON.parse(log(worktree, `agent/${id}`, 'records/loops/r1/translation-ko-1-runs.json'))).toEqual({ runs: [], translation: { ja: { text: 1, glossary: 0 } } });
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
  });

  it('adds the hook command to an existing pre-commit hook once', async () => {
    const ws = makeWorkspace();
    const { ensurePreCommitHook } = await import('../../../src/commands/agent/lib/launch.ts');
    mkdirSync(join(ws.coreImpl, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(ws.coreImpl, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho mine\n');
    await ensurePreCommitHook(ws.coreImpl);
    await ensurePreCommitHook(ws.coreImpl);
    const hook = readFileSync(join(ws.coreImpl, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(hook.split('\n')[0]).toBe('#!/bin/sh');
    expect(hook.match(/meta sync core --staged/g)?.length).toBe(1);
    expect(hook).toContain('echo mine');
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

describe.runIf(process.platform === 'darwin')('ogw agent: play and judge', () => {
  it('runs play in a sandboxed temp folder, then moves the result, captures and run log', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n', 'secret.txt': 'hidden' });
    const evidenceDir = join(root, 'records/loops/r1/evidence');
    const behavior = [
      `let blocked = 'no'; try { fs.readFileSync(${JSON.stringify(join(root, 'secret.txt'))}); } catch { blocked = 'yes'; }`,
      "fs.mkdirSync('captures'); fs.writeFileSync('captures/shot.png', 'png');",
      'const guide = JSON.parse(fs.readFileSync(input, \'utf8\')).playGuide;',
      "fs.writeFileSync(output, 'blocked ' + blocked + '\\nguide ' + fs.readFileSync(guide, 'utf8') + 'capture ' + process.cwd() + '/captures/shot.png\\n');",
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null }));
    const { id, waited } = await runAgent(ws, ['play', '--game', 'g', '--input', join(ws.root, 'play.json')], fake.env, root);
    const final = join(root, 'records/loops/r1/play-1-1.md');
    expect(waited).toMatchObject({ code: 0, stdout: `${final}\n` });
    expect(readFileSync(final, 'utf8')).toBe(`blocked yes\nguide # guide\ncapture ${join(evidenceDir, 'play-1-1')}/shot.png\n`);
    expect(readFileSync(join(evidenceDir, 'play-1-1', 'shot.png'), 'utf8')).toBe('png');
    const call = fake.calls()[0];
    expect(existsSync(call?.cwd as string)).toBe(false);
    expect(call?.prompt).not.toContain('## purpose');
    expect(call?.prompt).toContain(`- input: ${call?.cwd as string}/input/input.json`);
    expect(log(root, 'loop/r1', 'records/loops/r1/play-1-1-runs.json')).toBe('{\n  "runs": []\n}\n');
    expect((await readJob(id, ws.env)).meta).toMatchObject({ instances: ['inst1'], k: 1, output: final });
    const second = await runAgent(ws, ['play', '--game', 'g', '--input', join(ws.root, 'play.json')], fake.env, root);
    expect(second.waited.stdout).toBe(`${join(root, 'records/loops/r1/play-1-2.md')}\n`);
  });

  it('moves every named secret out of the old store before the play sandbox starts', async () => {
    const ws = makeWorkspace();
    const settings = { environments: { PROD: { secrets: { deploySsh: 'ssh-prod' } } } };
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n', 'settings.json': settings });
    const old = join(ws.root, 'old-secrets.json');
    writeFileSync(old, JSON.stringify({ 'ogw/g/PROD/ssh-prod': 'ssh key', 'ogw/g/PROD/unnamed': 'stays' }));
    const fake = fakeAgentCli(ws, WRITE_OUTPUT);
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null }));
    const env = { ...fake.env, OGW_TEST_OLD_SECRET_FILE: old };
    const { waited } = await runAgent(ws, ['play', '--game', 'g', '--input', join(ws.root, 'play.json')], env, root);
    expect(waited.code).toBe(0);
    expect(JSON.parse(readFileSync(old, 'utf8'))).toEqual({ 'ogw/g/PROD/unnamed': 'stays' });
    expect(JSON.parse(readFileSync(ws.env.OGW_TEST_SECRET_FILE as string, 'utf8'))).toEqual({ 'ogw/g/PROD/ssh-prod': 'ssh key' });
  });

  it('runs play with the user login and blocks the other sessions, agent logs, instance records and play access files', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n', 'in.md': 'x' });
    const content = fakeAgentCli(ws, "console.log('content agent read design.md'); " + WRITE_OUTPUT);
    const contentRun = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'in.md')], content.env, root);
    expect(contentRun.waited.code).toBe(0);
    const logs = join(await jobsDir(ws.env), 'agent-logs');
    const contentLogs = [`${contentRun.id}.cli.log`, `${contentRun.id}.stdout`, `${contentRun.id}.stderr`].map((name) => join(logs, name));
    const home = ws.env.CLAUDE_CONFIG_DIR as string;
    mkdirSync(join(home, 'projects', 'p'), { recursive: true });
    writeFileSync(join(home, 'projects', 'p', 't.jsonl'), 'brief.md says');
    writeFileSync(join(home, 'history.jsonl'), 'make the boss easier');
    writeFileSync(join(home, '.credentials.json'), 'login');
    writeFileSync(join(home, 'settings.json'), '{}');
    const record = join(await instancesDir(ws.env), 'inst1.json');
    const access = join(await playAccessDir(ws.env), 'inst1.json');
    for (const path of [record, access]) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, '{"token": "t"}');
    }
    const readable = (path: string): string => `(() => { try { fs.readFileSync(${JSON.stringify(path)}); return 'readable'; } catch { return 'blocked'; } })()`;
    // the play access files are in the harness git common dir too: the play commands reach them through the broker
    const blockedPaths = [join(home, 'projects', 'p', 't.jsonl'), join(home, 'history.jsonl'), ...contentLogs, record, access];
    const keptPaths = [join(home, '.credentials.json'), join(home, 'settings.json')];
    const behavior = [
      `const seen = [${[...blockedPaths, ...keptPaths].map(readable).join(', ')}];`,
      "fs.writeFileSync(output, seen.join(' ') + '\\n' + process.env.CLAUDE_CONFIG_DIR + '\\n');",
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null }));
    const { waited } = await runAgent(ws, ['play', '--game', 'g', '--input', join(ws.root, 'play.json')], fake.env, root);
    expect(waited.code).toBe(0);
    const [seen, config] = readFileSync(join(root, 'records/loops/r1/play-1-1.md'), 'utf8').split('\n');
    expect(seen).toBe('blocked blocked blocked blocked blocked blocked blocked readable readable');
    // the default config folder: Claude Code finds the user's login there (or in the macOS Keychain under its name)
    expect(config).toBe(home);
    expect(fake.calls()[0]?.argv).toContain('--no-session-persistence');
    expect(readFileSync(contentLogs[0] as string, 'utf8')).toContain('content agent read design.md');
  });

  it('keeps play from writing git and agent CLI config in home, and still commits its run log', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n' });
    // the job and the agent use the workspace as their temp folder (the fake CLI records its calls there); home is
    // outside it
    const home = await newTempFolder('ogw-home-');
    for (const path of [join(home, '.claude'), join(home, '.codex')]) mkdirSync(path, { recursive: true });
    const targets = [join(home, '.gitconfig'), join(home, '.claude', 'settings.json'), join(home, '.codex', 'config.toml'), join(home, '.zshrc')];
    const behavior = [
      `const seen = ${JSON.stringify(targets)}.map((path) => { try { fs.writeFileSync(path, '[core]\\n\\tfsmonitor = /x\\n'); return 'written'; } catch { return 'blocked'; } });`,
      "fs.writeFileSync(output, seen.join(' ') + '\\n');",
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    const env = { ...fake.env, HOME: home, TMPDIR: ws.root, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' };
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null }));
    const { waited } = await runAgent(ws, ['play', '--game', 'g', '--input', join(ws.root, 'play.json')], env, root);
    expect(waited).toMatchObject({ code: 0 });
    expect(readFileSync(join(root, 'records/loops/r1/play-1-1.md'), 'utf8')).toBe('blocked blocked blocked blocked\n');
    for (const path of targets) expect(existsSync(path)).toBe(false);
    expect(log(root, 'loop/r1', 'records/loops/r1/play-1-1-runs.json')).toBe('{\n  "runs": []\n}\n');
  });

  it('blocks a session folder that a process outside the sandbox makes after play started, under a symlinked config folder', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n' });
    const realHome = join(ws.root, 'real-claude');
    mkdirSync(realHome, { recursive: true });
    const linkHome = join(ws.root, 'link-claude');
    symlinkSync(realHome, linkHome);
    const marks = join(ws.root, 'marks');
    mkdirSync(marks);
    const late = [join(linkHome, 'todos', 't.json'), join(realHome, 'todos', 't.json'), join(realHome, 'plans', 'p.md')];
    const readable = (path: string): string => `(() => { try { fs.readFileSync(${JSON.stringify(path)}); return 'readable'; } catch { return 'blocked'; } })()`;
    const behavior = [
      `fs.writeFileSync(${JSON.stringify(join(marks, 'started'))}, '');`,
      `for (let i = 0; i < 400 && !fs.existsSync(${JSON.stringify(join(marks, 'go'))}); i++) await new Promise((r) => setTimeout(r, 50));`,
      `fs.writeFileSync(output, [${late.map(readable).join(', ')}].join(' ') + '\\n');`,
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    const env = { ...fake.env, CLAUDE_CONFIG_DIR: linkHome };
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null }));
    const started = await ogw(ws, ['agent', 'play', '--game', 'g', '--input', join(ws.root, 'play.json'), '--background'], { env, cwd: root });
    expect(started.code).toBe(0);
    for (let i = 0; i < 400 && !existsSync(join(marks, 'started')); i++) await new Promise((r) => setTimeout(r, 50));
    // another agent outside the sandbox writes its session records only now, at the resolved path
    for (const path of late.slice(1)) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, 'brief.md says');
    }
    writeFileSync(join(marks, 'go'), '');
    const waited = await ogw(ws, ['agent', 'wait', started.stdout.trim(), '--timeout', '60000'], { env });
    expect(waited.code).toBe(0);
    expect(readFileSync(join(root, 'records/loops/r1/play-1-1.md'), 'utf8')).toBe('blocked blocked blocked\n');
  });

  it('commits and removes after play only what the job set before the agent CLI started, not what its record says then', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n' });
    const victim = join(ws.root, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'keep');
    const marks = join(ws.root, 'marks');
    mkdirSync(marks);
    const behavior = [
      `fs.writeFileSync(${JSON.stringify(join(marks, 'started'))}, '');`,
      `for (let i = 0; i < 400 && !fs.existsSync(${JSON.stringify(join(marks, 'go'))}); i++) await new Promise((r) => setTimeout(r, 50));`,
      "fs.writeFileSync(output, 'result\\n');",
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null }));
    const started = await ogw(ws, ['agent', 'play', '--game', 'g', '--input', join(ws.root, 'play.json'), '--background'], { env: fake.env, cwd: root });
    expect(started.code).toBe(0);
    const id = started.stdout.trim();
    for (let i = 0; i < 400 && !existsSync(join(marks, 'started')); i++) await new Promise((r) => setTimeout(r, 50));
    // the record changes while the agent CLI runs, as a process that can write the jobs folder would change it
    const recordPath = join(await jobsDir(ws.env), `${id}.json`);
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { meta: Record<string, unknown> };
    record.meta.place = { kind: 'tool-worktree', harness: ws.coreImpl, baseCommit: 'HEAD' };
    record.meta.worktree = victim;
    writeFileSync(recordPath, JSON.stringify(record));
    writeFileSync(join(marks, 'go'), '');
    const waited = await ogw(ws, ['agent', 'wait', id, '--timeout', '60000'], { env: fake.env });
    expect(waited).toMatchObject({ code: 0, stdout: `${join(root, 'records/loops/r1/play-1-1.md')}\n` });
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('fails play whose result file or run log is a symlink, and commits and copies nothing it points to', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n', 'brief.md': 'the brief\n', 'server/a.ts': 'a\n' });
    // a change the content agent has not committed
    writeFileSync(join(root, 'server', 'a.ts'), 'uncommitted\n');
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null }));
    const before = sh(root, 'git', ['rev-parse', 'loop/r1']).trim();
    const cases = [
      { link: "output.replace(/\\.md$/, '-runs.json')", target: join(root, 'server'), problem: 'the run log is not a regular file', writes: WRITE_OUTPUT },
      { link: 'output', target: join(root, 'brief.md'), problem: 'the result file is not a regular file', writes: '' },
    ];
    for (const [i, { link, target, problem, writes }] of cases.entries()) {
      const behavior = [writes, `fs.rmSync(${link}, { force: true }); fs.symlinkSync(${JSON.stringify(target)}, ${link});`].join('\n');
      const fake = fakeAgentCli(ws, behavior);
      const { waited } = await runAgent(ws, ['play', '--game', 'g', '--input', join(ws.root, 'play.json')], fake.env, root);
      expect(waited.code, problem).toBe(1);
      expect(waited.stdout).toContain(`failed: ${problem}`);
      const final = join(root, `records/loops/r1/play-1-${String(i + 1)}.md`);
      if (link === 'output') expect(existsSync(final)).toBe(false);
    }
    expect(sh(root, 'git', ['log', '--format=%s', `${before}..loop/r1`]).trim().split('\n')).toEqual([expect.stringMatching(/: run log$/)]);
    expect(sh(root, 'git', ['show', '--name-only', '--format=', 'loop/r1']).trim()).toBe('records/loops/r1/play-1-2-runs.json');
    expect(sh(root, 'git', ['status', '--porcelain', 'server']).trim()).toBe('M server/a.ts');
  });

  it('ends the running jobs the play agent started when its CLI ends, and marks them failed', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n' });
    const marks = join(ws.root, 'marks');
    mkdirSync(marks);
    const behavior = [
      `fs.writeFileSync(${JSON.stringify(join(marks, 'started'))}, '');`,
      `for (let i = 0; i < 400 && !fs.existsSync(${JSON.stringify(join(marks, 'go'))}); i++) await new Promise((r) => setTimeout(r, 50));`,
      WRITE_OUTPUT,
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null }));
    const started = await ogw(ws, ['agent', 'play', '--game', 'g', '--input', join(ws.root, 'play.json'), '--background'], { env: fake.env, cwd: root });
    expect(started.code).toBe(0);
    const id = started.stdout.trim();
    for (let i = 0; i < 400 && !existsSync(join(marks, 'started')); i++) await new Promise((r) => setTimeout(r, 50));
    // a job the agent started through its broker, still running: its supervisor and command processes
    const sleeper = (): ChildProcess => spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const [supervisor, command] = [sleeper(), sleeper()];
    const gone = (child: ChildProcess): Promise<void> =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else
          child.once('exit', () => {
            resolve();
          });
      });
    try {
      // the start times the supervisor records: a pid is signalled only while it is the recorded process
      const startedAt = (child: ChildProcess): string | null => processStartedAt(child.pid as number);
      writeJob(await jobsDir(ws.env), { id: 'sub1', agentJob: id, supervisorPid: supervisor.pid ?? null, supervisorStartedAt: startedAt(supervisor), pid: command.pid ?? null, pidStartedAt: startedAt(command), pidNs: pidNamespace() });
      writeFileSync(join(marks, 'go'), '');
      const waited = await ogw(ws, ['agent', 'wait', id, '--timeout', '60000'], { env: fake.env });
      expect(waited.code).toBe(0);
      await Promise.all([gone(supervisor), gone(command)]);
      expect((await readJob('sub1', ws.env)).status).toBe('failed');
    } finally {
      supervisor.kill('SIGKILL');
      command.kill('SIGKILL');
    }
  });

  it('ends the running jobs a content agent started when its CLI ends', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'records/loops/r1/content-input-1.md': '## request\nnone\n' });
    const marks = join(ws.root, 'marks');
    mkdirSync(marks);
    const behavior = [
      `fs.writeFileSync(${JSON.stringify(join(marks, 'started'))}, '');`,
      `for (let i = 0; i < 400 && !fs.existsSync(${JSON.stringify(join(marks, 'go'))}); i++) await new Promise((r) => setTimeout(r, 50));`,
      WRITE_OUTPUT,
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    const started = await ogw(ws, ['agent', 'content', '--game', 'g', '--input', join(root, 'records/loops/r1/content-input-1.md'), '--background'], { env: fake.env, cwd: root });
    expect(started.code).toBe(0);
    const id = started.stdout.trim();
    for (let i = 0; i < 400 && !existsSync(join(marks, 'started')); i++) await new Promise((r) => setTimeout(r, 50));
    // a job the content agent started, still running (for example an `instance start` waiting for a slot)
    const command = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    try {
      writeJob(await jobsDir(ws.env), { id: 'csub1', agentJob: id, supervisorPid: null, pid: command.pid ?? null, pidStartedAt: processStartedAt(command.pid as number), pidNs: pidNamespace() });
      writeFileSync(join(marks, 'go'), '');
      const waited = await ogw(ws, ['agent', 'wait', id, '--timeout', '60000'], { env: fake.env });
      expect(waited.code).toBe(0);
      expect((await readJob('csub1', ws.env)).status).toBe('failed');
    } finally {
      command.kill('SIGKILL');
    }
  });

  it('identifies the sandboxed play agent by its key, where ps cannot run, and gives no other agent key', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n' });
    const behavior = [
      'let refused = "";',
      `try { execFileSync(process.execPath, [${JSON.stringify(cliEntry())}, 'command', 'inst9', 'ping'], { stdio: 'pipe' }); } catch (e) { refused = String(e.stderr); }`,
      `try { execFileSync(process.execPath, [${JSON.stringify(cliEntry())}, 'job', 'status', 'nojob'], { stdio: 'pipe' }); } catch {}`,
      "fs.writeFileSync(output, refused + '\\nkey ' + (process.env.OGW_AGENT_KEY ?? '').split('.')[0] + '\\n');",
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null }));
    const { id, waited } = await runAgent(ws, ['play', '--game', 'g', '--input', join(ws.root, 'play.json')], { ...fake.env, OGW_AGENT_KEY: 'zz.forged' }, root);
    expect(waited.code).toBe(0);
    const [refused, key] = readFileSync(join(root, 'records/loops/r1/play-1-1.md'), 'utf8').split('\n').filter((line) => line !== '');
    // the broker runs no `ogw command`; a broker command runs as the play agent, found by its key
    expect(refused).toContain('ogw broker: ogw command inst9 is not a command of the play and judge agents');
    expect(key).toBe(`key ${id}`);
    const runLog = JSON.parse(log(root, 'loop/r1', 'records/loops/r1/play-1-1-runs.json')) as { runs: { command: string }[] };
    expect(runLog.runs.map((entry) => entry.command)).toEqual(['ogw job status nojob']);
    const meta = (await readJob(id, ws.env)).meta;
    expect(meta.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('runs a forwarded command with the job environment without the dropped variables, the job id and the login token, with the agent key and TMPDIR', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n' });
    writeFileSync(join(ws.root, 'secrets.json'), JSON.stringify({ 'ogw/harness/claude-code-oauth-token': 'long-lived-token' }));
    // every node process loads this; the one the broker starts writes its environment
    const dump = join(ws.root, 'broker-env.json');
    const hook = join(ws.root, 'dump-env.mjs');
    writeFileSync(hook, `import { writeFileSync } from 'node:fs';\nif (process.argv.includes(${JSON.stringify(BROKER_RUN)})) writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));\n`);
    const behavior = [
      `try { execFileSync(process.execPath, [${JSON.stringify(cliEntry())}, 'job', 'status', 'nojob'], { stdio: 'pipe' }); } catch {}`,
      "fs.writeFileSync(output, (process.env.OGW_AGENT_KEY ?? '') + '\\n' + process.cwd() + '\\n' + (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '') + '\\n');",
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    const dropped = {
      DOCKER_HOST: `unix://${join(ws.root, 'docker.sock')}`,
      DOCKER_CONTEXT: 'other',
      SSH_AUTH_SOCK: join(ws.root, 'agent.sock'),
      TMUX: `${join(ws.root, 'tmux-1', 'default')},1,0`,
      TMUX_PANE: '%1',
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(ws.root, 'bus')}`,
      XDG_RUNTIME_DIR: join(ws.root, 'run'),
    };
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null }));
    const env = { ...fake.env, ...dropped, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`, OGW_MARK: 'kept' };
    const { id, waited } = await runAgent(ws, ['play', '--game', 'g', '--input', join(ws.root, 'play.json')], env, root);
    expect(waited.code).toBe(0);
    const [key, folder, token] = readFileSync(join(root, 'records/loops/r1/play-1-1.md'), 'utf8').split('\n');
    expect(key?.startsWith(`${id}.`)).toBe(true);
    // the agent CLI gets the login token; the broker and the commands it runs do not
    expect(token).toBe('long-lived-token');
    expect(readFileSync(dump, 'utf8')).not.toContain('long-lived-token');
    const seen = JSON.parse(readFileSync(dump, 'utf8')) as Record<string, string>;
    expect(seen.OGW_AGENT_KEY).toBe(key);
    expect(seen.TMPDIR).toBe(join(folder as string, 'tmp'));
    expect(seen.OGW_MARK).toBe('kept');
    expect(Object.keys(seen).filter((name) => name in dropped || name === 'OGW_JOB_ID' || name === 'OGW_BROKER_SOCKET')).toEqual([]);
  });

  it('does not start play with an input that is not JSON', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws);
    writeFileSync(join(ws.root, 'play.json'), '{');
    const run = await ogw(ws, ['agent', 'play', '--game', 'g', '--input', join(ws.root, 'play.json')], { cwd: root });
    expect(run).toMatchObject({ code: 1 });
    expect(run.stderr).toContain('play input is not JSON');
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
