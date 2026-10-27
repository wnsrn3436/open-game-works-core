import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { instancesDir, playAccessDir } from '../../../src/commands/instance/lib/records.ts';
import { jobsDir, readJob } from '../../../src/lib/jobs.ts';
import { cliEntry } from '../../../src/lib/paths.ts';
import { BROKER_RUN } from '../../../src/lib/broker-client.ts';
import { pidNamespace, processStartedAt } from '../../../src/lib/proc.ts';
import { writeJob } from '../job/helpers.ts';
import { newTempFolder } from '../../../src/commands/agent/lib/files.ts';
import { ogw, makeGame, makeWorkspace, sh } from '../../helpers/workspace.ts';
import { createContext } from '../../../src/lib/command.ts';
import { startAgentJob } from '../../../src/commands/agent/api.ts';
import { fakeAgentCli, gameWithRun, runAgent, WRITE_OUTPUT } from './helpers.ts';

function log(root: string, rev: string, path: string): string {
  return sh(root, 'git', ['show', `${rev}:${path}`]);
}

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

  it('runs a judge of ogw judge calibrate without a run, with its result file and captures in the calibration folders', async () => {
    const ws = makeWorkspace();
    const root = makeGame(ws, 'g', { 'settings.json': {}, 'play-guide.md': '# guide\n' });
    const fake = fakeAgentCli(ws, "fs.mkdirSync('captures'); fs.writeFileSync('captures/shot.png', 'png'); fs.writeFileSync(output, 'capture ' + process.cwd() + '/captures/shot.png\\n');");
    const input = join(ws.root, 'judge.json');
    writeFileSync(input, JSON.stringify({ A: { instance: 'a', playGuide: join(root, 'play-guide.md') }, B: null, fixtures: [], elements: ['game feel'], telemetry: null, reference: null }));
    const ctx = createContext({ cwd: root, env: { ...ws.env, ...fake.env }, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const output = join(root, 'records/calibration/5/judge-null-1-1.md');
    const evidence = join(root, 'builds/calibration/5/judge-null-1-1');
    const id = await startAgentJob(ctx, { role: 'judge', game: 'g', input, calibration: { output, evidence } });
    const waited = await ogw(ws, ['agent', 'wait', id, '--timeout', '60000'], { env: fake.env });
    expect(waited).toMatchObject({ code: 0, stdout: `${output}\n` });
    expect(readFileSync(output, 'utf8')).toBe(`capture ${evidence}/shot.png\n`);
    expect(readFileSync(join(evidence, 'shot.png'), 'utf8')).toBe('png');
    expect(fake.calls()[0]?.prompt).not.toContain('- run:');
    expect(log(root, 'main', 'records/calibration/5/judge-null-1-1-runs.json')).toBe('{\n  "runs": []\n}\n');
    expect((await readJob(id, ws.env)).meta).toMatchObject({ run: null, iteration: null, k: null });
    const outside = startAgentJob(ctx, { role: 'judge', game: 'g', input, calibration: { output: join(root, 'records/loops/x.md'), evidence } });
    await expect(outside).rejects.toThrow('a calibration result file is a .md file under');
    await expect(startAgentJob(ctx, { role: 'play', game: 'g', input, calibration: { output, evidence } })).rejects.toThrow('a calibration place is given only to role judge');
  });

  it('runs a judge of ogw loop variants in the open run, with its result file and captures at its run place', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n' }, { iteration: 2 });
    const fake = fakeAgentCli(ws, "fs.mkdirSync('captures'); fs.writeFileSync('captures/shot.png', 'png'); fs.writeFileSync(output, 'capture ' + process.cwd() + '/captures/shot.png\\n');");
    const input = join(ws.root, 'judge.json');
    writeFileSync(input, JSON.stringify({ A: { instance: 'a', playGuide: join(root, 'play-guide.md') }, B: null, fixtures: [], elements: ['game feel'], telemetry: null, reference: null }));
    const ctx = createContext({ cwd: root, env: { ...ws.env, ...fake.env }, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const output = join(root, 'records/loops/r1/judge-2-v1-1.md');
    const evidence = join(root, 'records/loops/r1/evidence/judge-2-v1-1');
    const id = await startAgentJob(ctx, { role: 'judge', game: 'g', input, runPlace: { output, evidence } });
    const waited = await ogw(ws, ['agent', 'wait', id, '--timeout', '60000'], { env: fake.env });
    expect(waited).toMatchObject({ code: 0, stdout: `${output}\n` });
    expect(readFileSync(output, 'utf8')).toBe(`capture ${evidence}/shot.png\n`);
    expect(fake.calls()[0]?.prompt).toContain('- run: r1\n- iteration: 2');
    // the place is not counted as the k-th judge of the iteration
    expect((await readJob(id, ws.env)).meta).toMatchObject({ run: 'r1', iteration: 2, k: null });
    const outside = startAgentJob(ctx, { role: 'judge', game: 'g', input, runPlace: { output: join(root, 'records/loops/x.md'), evidence } });
    await expect(outside).rejects.toThrow('a run result file is a .md file in');
    const both = startAgentJob(ctx, { role: 'judge', game: 'g', input, runPlace: { output, evidence }, calibration: { output, evidence } });
    await expect(both).rejects.toThrow('a run place is given only to role judge, without a calibration place');
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
