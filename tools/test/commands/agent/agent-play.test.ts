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
import { fakeAgentCli, gameWithRun, noUsage, readRunLog, runAgent, WRITE_OUTPUT } from './helpers.ts';

describe.runIf(process.platform === 'darwin')('ogw agent: play and judge', () => {
  it('runs play in a sandboxed temp folder, then moves the result and captures; its run log is in the jobs folder, out of its reach', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n', 'secret.txt': 'hidden' });
    const before = sh(root, 'git', ['rev-parse', 'loop/r1']);
    const evidenceDir = join(root, 'records/loops/r1/evidence');
    const behavior = [
      `let blocked = 'no'; try { fs.readFileSync(${JSON.stringify(join(root, 'secret.txt'))}); } catch { blocked = 'yes'; }`,
      "let forged = 'no'; try { fs.writeFileSync(runLog, '{\"runs\": []}'); forged = 'yes'; } catch {}",
      "fs.mkdirSync('captures'); fs.writeFileSync('captures/shot.png', 'png');",
      'const guide = JSON.parse(fs.readFileSync(input, \'utf8\')).playGuide;',
      "fs.writeFileSync(output, 'blocked ' + blocked + '\\nrun log written ' + forged + '\\nguide ' + fs.readFileSync(guide, 'utf8') + 'capture ' + process.cwd() + '/captures/shot.png\\n| 1 | captures/shot.png\\nscreencaptures/shot.png\\n' + '\\n## observations\\n\\nnone\\n');",
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null }));
    const { id, waited } = await runAgent(ws, ['play', '--game', 'g', '--input', join(ws.root, 'play.json')], fake.env, root);
    const final = join(root, 'records/loops/r1/play-1-1.md');
    expect(waited).toMatchObject({ code: 0, stdout: `${final}\n` });
    expect(readFileSync(final, 'utf8')).toBe(`blocked yes\nrun log written no\nguide # guide\ncapture ${join(evidenceDir, 'play-1-1')}/shot.png\n| 1 | ${join(evidenceDir, 'play-1-1')}/shot.png\nscreencaptures/shot.png\n\n## observations\n\nnone\n`);
    expect(readFileSync(join(evidenceDir, 'play-1-1', 'shot.png'), 'utf8')).toBe('png');
    const call = fake.calls()[0];
    expect(existsSync(call?.cwd as string)).toBe(false);
    expect(call?.prompt).not.toContain('## purpose');
    expect(call?.prompt).toContain(`- input: ${call?.cwd as string}/input/input.json`);
    expect(await readRunLog(ws, id)).toEqual({ runs: [], usage: noUsage('claude-sonnet-5-5', 'medium') });
    // nothing is committed, and the checkout has only the result file and the evidence
    expect(sh(root, 'git', ['rev-parse', 'loop/r1'])).toBe(before);
    expect(sh(root, 'git', ['status', '--porcelain', '--untracked-files=all']).split('\n').filter((line) => line !== '' && !line.startsWith('?? records/loops/r1/evidence/'))).toEqual(['?? records/loops/r1/play-1-1.md']);
    expect((await readJob(id, ws.env)).meta).toMatchObject({ instances: ['inst1'], k: 1, output: final });
    expect((await readJob(id, ws.env)).timeLimitMs).toBe(2_700_000);
    const second = await runAgent(ws, ['play', '--game', 'g', '--input', join(ws.root, 'play.json')], fake.env, root);
    expect(second.waited.stdout).toBe(`${join(root, 'records/loops/r1/play-1-2.md')}\n`);
  });

  it('fails a judge whose result has no table that its input asks for at once: a judge keeps no session to continue', async () => {
    const ws = makeWorkspace({ resultFixRounds: 2 });
    const root = makeGame(ws, 'g', { 'settings.json': {}, 'play-guide.md': '# guide\n' });
    const fake = fakeAgentCli(ws, "fs.writeFileSync(output, '## vs baseline\\n\\nnone\\n\\n## vs reference\\n\\n| instance | element | result | reason | evidence |\\n|---|---|---|---|---|\\n| A | game feel | good | r | e |\\n');");
    const input = join(ws.root, 'judge.json');
    const game = { instance: 'a', playGuide: join(root, 'play-guide.md') };
    writeFileSync(input, JSON.stringify({ A: game, B: { ...game, instance: 'b' }, fixtures: [], elements: ['game feel'], telemetry: null, reference: { name: 'ref', presentation: 'ref', moments: [] } }));
    const ctx = createContext({ cwd: root, env: { ...ws.env, ...fake.env }, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const output = join(root, 'records/calibration/6/judge-a-1.md');
    const id = await startAgentJob(ctx, { role: 'judge', game: 'g', input, calibration: { output, evidence: join(root, 'builds/calibration/6/judge-a-1') } });
    const waited = await ogw(ws, ['agent', 'wait', id, '--timeout', '60000'], { env: fake.env });
    expect(waited.code).toBe(1);
    expect(waited.stdout).toContain(`failed: result file: \`## vs baseline\` table missing; \`## vs reference\` row A game feel: unknown result good, not one of pass, fail, unknown, n/a\noutput: ${output}\n`);
    expect(fake.calls()).toHaveLength(1);
    // nor a Codex judge, whose first run names its thread
    const codex = fakeAgentCli(ws, `process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\\n'); fs.writeFileSync(output, '## vs baseline\\n\\nnone\\n');`);
    const viaCodex = await startAgentJob(createContext({ cwd: root, env: { ...ws.env, ...codex.env }, stdin: () => Promise.resolve(''), stderr: () => undefined }), {
      role: 'judge', game: 'g', input, calibration: { output, evidence: join(root, 'builds/calibration/6/judge-a-3') }, agent: { cli: 'codex', model: 'gpt-x', effort: 'low' },
    });
    expect((await ogw(ws, ['agent', 'wait', viaCodex, '--timeout', '60000'], { env: codex.env })).stdout).toContain('failed: result file: `## vs baseline` table missing; `## vs reference` table missing\n');
    expect(codex.calls()).toHaveLength(1);
    // a judge keeps no session: Codex runs ephemeral, and its thread is not the session of the job
    expect(codex.calls()[0]?.argv.slice(-2)).toEqual(['--ephemeral', '-']);
    expect((await readJob(viaCodex, ws.env)).meta.session ?? null).toBeNull();
    expect((await readJob(viaCodex, ws.env)).meta.sessionUsage).toBeUndefined();
    // the input sets what is read: without B and reference, neither table
    writeFileSync(input, JSON.stringify({ A: game, B: null, fixtures: [], elements: ['game feel'], telemetry: null, reference: null }));
    const free = await startAgentJob(ctx, { role: 'judge', game: 'g', input, calibration: { output, evidence: join(root, 'builds/calibration/6/judge-a-2') } });
    expect((await ogw(ws, ['agent', 'wait', free, '--timeout', '60000'], { env: fake.env })).code).toBe(0);
  });

  it('fails a play agent whose feedback has no observations section at once', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n' });
    const fake = fakeAgentCli(ws, "fs.writeFileSync(output, '## coverage\\n\\nall\\n');");
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null }));
    const { waited } = await runAgent(ws, ['play', '--game', 'g', '--input', join(ws.root, 'play.json')], fake.env, root);
    expect(waited.code).toBe(1);
    expect(waited.stdout).toContain(`failed: result file: \`## observations\` is missing\noutput: ${join(root, 'records/loops/r1/play-1-1.md')}\n`);
    expect(fake.calls()).toHaveLength(1);
  });

  it('fails a play agent at once whose feedback does not answer each defect of its input once, with a capture that exists for reproduced and absent', async () => {
    const ws = makeWorkspace({ resultFixRounds: 2 });
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n' });
    const defect = (id: string): object => ({ id, where: 'boss', what: 'stuck', seen: [] });
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null, defects: [defect('d1'), defect('d2')] }));
    const feedback = (rows: string[]): string => ['## observations', '', 'none', '', '## defects', '', '| id | result | capture | note |', '|---|---|---|---|', ...rows, ''].join('\n');
    const play = async (rows: string[]): Promise<{ code: number; stdout: string; calls: number }> => {
      const fake = fakeAgentCli(ws, `fs.mkdirSync('captures'); fs.writeFileSync('captures/shot.png', 'png'); fs.writeFileSync(output, ${JSON.stringify(feedback(rows))});`);
      const { waited } = await runAgent(ws, ['play', '--game', 'g', '--input', join(ws.root, 'play.json')], fake.env, root);
      return { ...waited, calls: fake.calls().length };
    };
    const output = join(root, 'records/loops/r1/play-1-1.md');
    const missing = await play(['| d1 | reproduced | captures/shot.png | stuck again |', '| d3 | gone | none | x |']);
    expect(missing).toMatchObject({ code: 1, calls: 1 });
    expect(missing.stdout).toContain(`failed: result file: \`## defects\` has no row of defect d2; \`## defects\` row d3: not a defect of the input; \`## defects\` row d3: result \`gone\` is not one of reproduced, absent, not reached\noutput: ${output}\n`);
    const twice = await play(['| d1 | absent | captures/none.png | fine |', '| d2 | not reached | none | x |', '| d2 | not reached | none | x |']);
    expect(twice.stdout).toContain('failed: result file: `## defects` has 2 rows of defect d2; `## defects` row d1: absent needs the path of a capture that exists, not `captures/none.png`\n');
    expect((await play(['| d1 | reproduced | captures/shot.png | stuck again |', '| d2 | not reached | none | never got there |'])).code).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain(`| d1 | reproduced | ${join(root, 'records/loops/r1/evidence/play-1-1')}/shot.png | stuck again |`);
    // with no defect to confirm the section is not read
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null, defects: [] }));
    expect((await play([])).code).toBe(0);
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
    expect(await readRunLog(ws, id)).toEqual({ runs: [], usage: noUsage('claude-opus-5-5', 'high') });
    expect(sh(root, 'git', ['ls-files', 'records/calibration'])).toBe('');
    expect((await readJob(id, ws.env)).meta).toMatchObject({ run: null, iteration: null, k: null });
    expect((await readJob(id, ws.env)).timeLimitMs).toBe(3_600_000);
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
      "fs.writeFileSync(output, seen.join(' ') + '\\n' + process.env.CLAUDE_CONFIG_DIR + '\\n' + '\\n## observations\\n\\nnone\\n');",
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

  it('keeps play from writing git and agent CLI config in home', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n' });
    // the job and the agent use the workspace as their temp folder (the fake CLI records its calls there); home is
    // outside it
    const home = await newTempFolder('ogw-home-');
    for (const path of [join(home, '.claude'), join(home, '.codex')]) mkdirSync(path, { recursive: true });
    const targets = [join(home, '.gitconfig'), join(home, '.claude', 'settings.json'), join(home, '.codex', 'config.toml'), join(home, '.zshrc')];
    const behavior = [
      `const seen = ${JSON.stringify(targets)}.map((path) => { try { fs.writeFileSync(path, '[core]\\n\\tfsmonitor = /x\\n'); return 'written'; } catch { return 'blocked'; } });`,
      "fs.writeFileSync(output, seen.join(' ') + '\\n' + '\\n## observations\\n\\nnone\\n');",
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    const env = { ...fake.env, HOME: home, TMPDIR: ws.root, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' };
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null }));
    const { waited } = await runAgent(ws, ['play', '--game', 'g', '--input', join(ws.root, 'play.json')], env, root);
    expect(waited).toMatchObject({ code: 0 });
    expect(readFileSync(join(root, 'records/loops/r1/play-1-1.md'), 'utf8')).toBe('blocked blocked blocked blocked\n\n## observations\n\nnone\n');
    for (const path of targets) expect(existsSync(path)).toBe(false);
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
      `fs.writeFileSync(output, [${late.map(readable).join(', ')}].join(' ') + '\\n' + '\\n## observations\\n\\nnone\\n');`,
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
    expect(readFileSync(join(root, 'records/loops/r1/play-1-1.md'), 'utf8')).toBe('blocked blocked blocked\n\n## observations\n\nnone\n');
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
      "fs.writeFileSync(output, 'result\\n' + '\\n## observations\\n\\nnone\\n');",
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

  it('fails play whose result file is a symlink, and commits and copies nothing it points to', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n', 'brief.md': 'the brief\n', 'server/a.ts': 'a\n' });
    // a change the content agent has not committed
    writeFileSync(join(root, 'server', 'a.ts'), 'uncommitted\n');
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null }));
    const before = sh(root, 'git', ['rev-parse', 'loop/r1']).trim();
    const fake = fakeAgentCli(ws, `fs.rmSync(output, { force: true }); fs.symlinkSync(${JSON.stringify(join(root, 'brief.md'))}, output);`);
    const { waited } = await runAgent(ws, ['play', '--game', 'g', '--input', join(ws.root, 'play.json')], fake.env, root);
    expect(waited.code).toBe(1);
    expect(waited.stdout).toContain('failed: the result file is not a regular file');
    expect(existsSync(join(root, 'records/loops/r1/play-1-1.md'))).toBe(false);
    expect(sh(root, 'git', ['rev-parse', 'loop/r1']).trim()).toBe(before);
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
      "fs.writeFileSync(output, refused + '\\nkey ' + (process.env.OGW_AGENT_KEY ?? '').split('.')[0] + '\\n' + '\\n## observations\\n\\nnone\\n');",
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null }));
    const { id, waited } = await runAgent(ws, ['play', '--game', 'g', '--input', join(ws.root, 'play.json')], { ...fake.env, OGW_AGENT_KEY: 'zz.forged' }, root);
    expect(waited.code).toBe(0);
    const [refused, key] = readFileSync(join(root, 'records/loops/r1/play-1-1.md'), 'utf8').split('\n').filter((line) => line !== '');
    // the broker runs no `ogw command`; a broker command runs as the play agent, found by its key
    expect(refused).toContain('ogw broker: ogw command inst9 is not a command of the play and judge agents');
    expect(key).toBe(`key ${id}`);
    const runLog = (await readRunLog(ws, id)) as { runs: { command: string }[] };
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
      "fs.writeFileSync(output, (process.env.OGW_AGENT_KEY ?? '') + '\\n' + process.cwd() + '\\n' + (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '') + '\\n' + '\\n## observations\\n\\nnone\\n');",
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
