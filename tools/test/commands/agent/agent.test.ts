import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hardeningRecords } from '../../../src/commands/loop/lib/findings.ts';
import { formatReviewInput } from '../../../src/commands/review/lib/input.ts';
import { instancesDir } from '../../../src/commands/instance/lib/records.ts';
import { jobsDir, readJob } from '../../../src/lib/jobs.ts';
import { requireOpenRun } from '../../../src/lib/runstate.ts';
import { cliEntry } from '../../../src/lib/paths.ts';
import { privateTempDir } from '../../../src/lib/secret-files.ts';
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
