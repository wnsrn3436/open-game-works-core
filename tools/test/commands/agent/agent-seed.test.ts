// The seed agent of `ogw regress refresh` in `ogw agent` (ogw.md `## agent`, `### seed agent` of `## regress`).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startAgentJob } from '../../../src/commands/agent/api.ts';
import { newAgentFolder } from '../../../src/commands/agent/lib/files.ts';
import { cliToRun } from '../../../src/commands/agent/lib/launch.ts';
import { buildPrompt } from '../../../src/commands/agent/lib/prompt.ts';
import { agentCliChecks, type CliStates } from '../../../src/commands/env/lib/hostcheck.ts';
import { dataDir } from '../../../src/commands/env/lib/host.ts';
import { createContext, type Context } from '../../../src/lib/command.ts';
import { jobLogPaths, readJob } from '../../../src/lib/jobs.ts';
import { agentCliLog } from '../../../src/commands/agent/lib/meta.ts';
import { runSeedAgent } from '../../../src/commands/regress/lib/seed-agent.ts';
import type { AgentSettings } from '../../../src/lib/settings.ts';
import { ogw, makeGame, makeWorkspace, realHarness, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeAgentCli } from './helpers.ts';

function ctxOf(ws: TestWorkspace, env: NodeJS.ProcessEnv = {}): Context {
  return createContext({ cwd: ws.root, env: { ...ws.env, ...env }, stdin: () => Promise.resolve(''), stderr: () => undefined });
}

const AGENT: AgentSettings = { cli: 'claude-code', model: 'm', effort: 'high' };

describe('ogw agent: seed', () => {
  it('starts only with the folder that ogw regress refresh makes, not on the command line, and gives that folder to no other role', async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws.root, 'input.md'), '## seed\n\nS01\n');
    const run = await ogw(ws, ['agent', 'seed', '--input', join(ws.root, 'input.md'), '--background']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('the seed agent starts only in ogw regress refresh, which makes its folder\n');
    makeGame(ws, 'g', { 'settings.json': {} });
    await expect(startAgentJob(ctxOf(ws), { role: 'core', input: join(ws.root, 'input.md'), seedPlace: ws.root })).rejects.toThrow('a seed folder is given only to role seed');
    const folder = await newAgentFolder('seed', ws.env);
    await expect(startAgentJob(ctxOf(ws), { role: 'seed', input: join(ws.root, 'input.md'), seedPlace: folder })).rejects.toThrow(`the input of the seed agent is not in its folder ${folder}`);
  });

  it('has a prompt of its definition alone, without the AGENTS.md sections', async () => {
    const prompt = await buildPrompt(realHarness, 'seed', { input: '/f/input.md', output: '/f/result.md', run: null, iteration: null });
    expect(prompt).toContain('You are the seed agent');
    expect(prompt).not.toContain('## purpose');
    expect(prompt).not.toContain('## terms');
    expect(prompt).toMatch(/## ogw agent\n\n- input: \/f\/input\.md\n- output: \/f\/result\.md\n$/);
    // its definition names no harness file for it to read
    expect(readFileSync(join(realHarness, 'agents', 'seed.md'), 'utf8')).not.toMatch(/\]\(\.\.\//);
  });

  it('blocks the harness repos, the regress repo and the regress data in its sandbox, which the judge sandbox reads, and keeps the seeds blocked for the agents of a game', async () => {
    const ws = makeWorkspace();
    const ctx = ctxOf(ws);
    mkdirSync(ws.regress, { recursive: true });
    const data = join(await dataDir(ctx), 'regress');
    mkdirSync(data, { recursive: true });
    const folder = await newAgentFolder('seed', ws.env);
    const workspace = await ctx.workspace();
    const profile = async (role: string, game: string | null = null): Promise<string> => {
      const cli = await cliToRun(ctx, role, AGENT, workspace, null, null, role === 'content' ? null : folder, game);
      return cli.profileFolder === null ? '' : readFileSync(join(cli.profileFolder, 'sandbox.sb'), 'utf8');
    };
    const deny = (text: string): string => text.split('\n').filter((line) => line.startsWith('(deny file-read* file-write*')).join('\n');
    const seed = await profile('seed');
    for (const path of [ws.harness, realHarness, ws.regress, data]) expect(deny(seed)).toContain(`(subpath "${path}")`);
    const judge = await profile('judge');
    expect(deny(judge)).not.toContain(`(subpath "${ws.harness}")`);
    expect(deny(judge)).not.toContain(`(subpath "${ws.regress}")`);
    // the agents of a game still block the regress repo and the seeds of the harness
    makeGame(ws, 'g', { 'settings.json': {} });
    const content = await profile('content', 'g');
    expect(content).toContain(`(subpath "${ws.regress}")`);
    if (existsSync(join(realHarness, 'regress'))) expect(content).toContain(`(subpath "${join(realHarness, 'regress')}")`);
  });

  it('checks the agent CLI of the seed agent in ogw env check apart from that of play and judge, in its own sandbox', async () => {
    const ws = makeWorkspace();
    const ctx = ctxOf(ws);
    const settings = await ctx.settings();
    const same = { cli: 'claude-code' as const, model: 'claude-opus-5-5', effort: 'high' };
    const none: CliStates = () => Promise.resolve({ installed: false, loggedIn: false, loginOutput: '' });
    const checks = await agentCliChecks(ctx, { ...settings, agents: { ...settings.agents, judge: same, seed: same, content: same } }, none);
    const rolesOf = (role: string): string[] | undefined => checks.find((check) => check.roles.includes(role))?.roles;
    expect(rolesOf('seed')).toEqual(['seed']);
    expect(rolesOf('judge')).not.toContain('seed');
    expect(rolesOf('content')).not.toContain('seed');
    expect(checks.find((check) => check.roles.includes('seed'))?.sandboxed).toBe(true);
  });
});

describe.runIf(process.platform === 'darwin')('ogw agent: the seed agent sandbox', () => {
  it('runs the seed agent in its folder with no broker and no session, reading neither the harness, the regress repo, the games nor another seed folder, and fails a result out of its format', async () => {
    const ws = makeWorkspace();
    const ctx0 = ctxOf(ws);
    makeGame(ws, 'g', { 'settings.json': {}, 'secret.txt': 'game' });
    mkdirSync(ws.regress, { recursive: true });
    writeFileSync(join(ws.regress, 'states.json'), '[]');
    const data = join(await dataDir(ctx0), 'regress');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'check.json'), '{}');
    mkdirSync(join(ws.coreReleases, '1.0.0'), { recursive: true });
    writeFileSync(join(ws.coreReleases, '1.0.0', 'core.txt'), 'core');
    const other = await newAgentFolder('seed', ws.env);
    writeFileSync(join(other, 'input.md'), 'another seed');
    const folder = await newAgentFolder('seed', ws.env);
    mkdirSync(join(folder, 'seed'));
    writeFileSync(join(folder, 'seed', 'seed.json'), '{}');
    writeFileSync(join(folder, 'input.md'), '## seed\n\nS01\n');
    const paths = {
      harness: join(ws.harness, 'AGENTS.md'),
      code: join(realHarness, 'AGENTS.md'),
      regress: join(ws.regress, 'states.json'),
      data: join(data, 'check.json'),
      game: join(ws.games, 'g', 'secret.txt'),
      other: join(other, 'input.md'),
      own: join(folder, 'seed', 'seed.json'),
      core: join(ws.coreReleases, '1.0.0', 'core.txt'),
    };
    const behavior = [
      `const paths = ${JSON.stringify(paths)};`,
      'const seen = {};',
      "for (const [name, path] of Object.entries(paths)) { try { fs.readFileSync(path); seen[name] = 'read'; } catch { seen[name] = 'blocked'; } }",
      'seen.broker = process.env.OGW_BROKER_SOCKET ?? null; seen.tmp = process.env.TMPDIR;',
      "fs.writeFileSync(output, fs.readFileSync(input, 'utf8').includes('BAD') ? '## reason\\n\\n\\n' : '## result\\n\\nnot rebased\\n\\n## reason\\n\\n' + JSON.stringify(seen) + '\\n');",
    ].join('\n');
    const fake = fakeAgentCli(ws, behavior);
    const ctx = ctxOf(ws, fake.env);
    const id = await startAgentJob(ctx, { role: 'seed', input: join(folder, 'input.md'), seedPlace: folder });
    const waited = await ogw(ws, ['agent', 'wait', id, '--timeout', '60000'], { env: fake.env });
    expect(waited).toMatchObject({ code: 0, stdout: `${join(folder, 'result.md')}\n` });
    const result = readFileSync(join(folder, 'result.md'), 'utf8');
    expect(JSON.parse(result.split('\n')[6] as string)).toEqual({
      harness: 'blocked',
      code: 'blocked',
      regress: 'blocked',
      data: 'blocked',
      game: 'blocked',
      other: 'blocked',
      own: 'read',
      core: 'read',
      broker: null,
      tmp: join(folder, 'tmp'),
    });
    const call = fake.calls()[0];
    expect(call?.cwd).toBe(folder);
    expect(call?.argv).toContain('--no-session-persistence');
    expect(call?.argv).not.toContain('--session-id');
    expect(call?.prompt).toContain('You are the seed agent');
    expect(call?.prompt).not.toContain('## purpose');
    expect(call?.prompt).toContain(`- input: ${folder}/input.md\n- output: ${folder}/result.md\n`);
    const meta = (await readJob(id, ws.env)).meta;
    expect(meta).toMatchObject({ role: 'seed', game: null, run: null, place: { kind: 'seed', dir: folder } });
    expect(meta.session ?? null).toBeNull();
    // the folder stays for the refresh, which removes it
    expect(existsSync(folder)).toBe(true);
    // a result file out of its format fails the job at once: the seed agent keeps no session to continue
    const second = await newAgentFolder('seed', ws.env);
    writeFileSync(join(second, 'input.md'), '## seed\n\nBAD\n');
    const failed = await startAgentJob(ctx, { role: 'seed', input: join(second, 'input.md'), seedPlace: second });
    const failedWait = await ogw(ws, ['agent', 'wait', failed, '--timeout', '60000'], { env: fake.env });
    expect(failedWait.code).toBe(1);
    expect(failedWait.stdout).toContain('failed: result file: `## result` is not one of `rebased`, `not rebased`; `## reason` is missing or empty\n');
    expect(fake.calls()).toHaveLength(2);
    expect((await ogw(ws, ['agent', 'retry', failed], { env: fake.env })).stderr).toContain(`job ${failed} is a seed agent of ogw regress refresh; it is not retried`);
  }, 90_000);

  it('waits for the job of the seed agent and removes its logs, which hold the seed, keeping its usage; a failure gives its failed line, not the tail of the log', async () => {
    const ws = makeWorkspace();
    const fake = fakeAgentCli(ws, "console.log('the patch of the seed'); fs.writeFileSync(output, fs.readFileSync(input, 'utf8').includes('BAD') ? 'no result\\n' : '## result\\n\\nrebased\\n\\n## reason\\n\\nr\\n');");
    const ctx = ctxOf(ws, fake.env);
    const run = async (text: string): Promise<{ ran: Awaited<ReturnType<typeof runSeedAgent>>; logs: string[] }> => {
      const folder = await newAgentFolder('seed', ws.env);
      writeFileSync(join(folder, 'input.md'), text);
      const ran = await runSeedAgent(ctx, folder, join(folder, 'input.md'));
      const job = await readJob(ran.job as string, ws.env);
      const logs = await jobLogPaths(job, ws.env);
      return { ran, logs: [await agentCliLog(job.id, ws.env), logs.stdout, logs.stderr].filter((path) => existsSync(path)) };
    };
    const done = await run('## seed\n\nS01\n');
    expect(done.ran).toMatchObject({ status: 'done', reason: null });
    expect(readFileSync(done.ran.output as string, 'utf8')).toContain('rebased');
    expect(done.logs).toEqual([]);
    expect((await readJob(done.ran.job as string, ws.env)).meta.usage).toMatchObject({ cli: 'claude-code', model: 'claude-opus-5-5' });
    const failed = await run('## seed\n\nBAD\n');
    expect(failed.ran).toMatchObject({ status: 'failed', output: null, reason: 'result file: `## result` is not one of `rebased`, `not rebased`; `## reason` is missing or empty' });
    expect(failed.logs).toEqual([]);
  }, 90_000);
});
