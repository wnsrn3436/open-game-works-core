import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { controlCall } from '../../../src/commands/instance/automation.ts';
import { readPlayAccess, readRecord } from '../../../src/commands/instance/lib/records.ts';
import { newAgentKey } from '../../../src/lib/agentctx.ts';
import { jobsDir } from '../../../src/lib/jobs.ts';
import { ogw } from '../../helpers/workspace.ts';
import { fakeAgentJob } from '../instance/agents.ts';
import { setupRunner, startFor, stopAll, type Runner } from '../instance/runner.ts';

vi.mock('../../../src/commands/generate/api.ts', async () => (await import('../instance/mocks/apis.ts')).generate);
vi.mock('../../../src/commands/data/api.ts', async () => (await import('../instance/mocks/apis.ts')).data);
vi.mock('../../../src/commands/core/api.ts', async () => (await import('../instance/mocks/apis.ts')).core);
vi.mock('../../../src/commands/env/api.ts', async () => (await import('../instance/mocks/apis.ts')).env);
vi.mock('../../../src/commands/instance/lib/spawn.ts', () => import('../instance/mocks/spawn.ts'));
vi.mock('../../../src/commands/instance/lib/launch.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/commands/instance/lib/launch.ts')>();
  return { ...real, ...(await import('../instance/mocks/apis.ts')).launchOverrides(real) };
});

let runner: Runner;
let id: string;

beforeAll(async () => {
  runner = setupRunner();
  runner.config({
    clients: { main: { results: { 'shop.open_shop': { ok: true, result: { opened: true } } }, fail: { set_user_state: 'bad kind' } } },
  });
  id = await startFor(runner);
});

afterAll(async () => {
  await stopAll(runner);
});

describe('ogw command', () => {
  it('sends a built-in or content command and prints ok and result', async () => {
    expect(await ogw(runner.ws, ['command', id, 'shop.open_shop'])).toMatchObject({ code: 0, stdout: '{"ok":true,"result":{"opened":true}}\n' });
    const run = await ogw(runner.ws, ['command', '--json', id, 'get_state']);
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, result: { boot_stage: 'Done', user_id: 42 } });
    expect(await ogw(runner.ws, ['command', id, 'set_user_state', 'Gold', '[]', '{}'])).toMatchObject({
      code: 1,
      stdout: '{"ok":false,"result":"bad kind"}\n',
    });
    expect(runner.requests('main').at(-1)).toMatchObject({ command: 'set_user_state', args: ['Gold', '[]', '{}'] });
  });

  it('refuses step commands and screen captures without sending them', async () => {
    const before = runner.requests('main').length;
    for (const name of ['set_step_mode', 'leave_match', 'step', 'capture_screen', 'capture_video']) {
      const run = await ogw(runner.ws, ['command', id, name, '1']);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain(`ogw command does not send ${name}`);
    }
    expect(runner.requests('main')).toHaveLength(before);
  });

  it('sends every token after the command name as an argument, as given', async () => {
    for (const args of [['--json'], ['--help'], ['--'], ['--abc'], ['a', '--json', '--', '--help', '-x']]) {
      const run = await ogw(runner.ws, ['command', id, 'player.set_name', ...args]);
      expect(run).toMatchObject({ code: 0, stdout: '{"ok":true,"result":null}\n' });
      expect(runner.requests('main').at(-1)).toMatchObject({ command: 'player.set_name', args });
    }
    const json = await ogw(runner.ws, ['command', id, '--json', 'text', '--json']);
    expect(JSON.parse(json.stdout)).toEqual({ ok: true, result: null });
    expect(json.stdout).toContain('\n  ');
    expect(runner.requests('main').at(-1)).toMatchObject({ command: 'text', args: ['--json'] });
  });

  it.each(['play', 'judge'])('refuses a call from a %s agent', async (role) => {
    const before = runner.requests('main').length;
    const remove = await fakeAgentJob(runner.ws.env, `agent${role}1`, { role, cliPid: process.ppid });
    try {
      const run = await ogw(runner.ws, ['command', id, 'get_state']);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain(`ogw command is not for the ${role} agent`);
    } finally {
      remove();
    }
    expect(runner.requests('main')).toHaveLength(before);
  });

  it('refuses a play agent found by its agent key, and sends nothing when the agent of the key cannot be read', async () => {
    const before = runner.requests('main').length;
    const key = newAgentKey('agentplay9');
    const remove = await fakeAgentJob(runner.ws.env, 'agentplay9', { role: 'play', cliPid: 999_999, keyHash: key.hash });
    try {
      const run = await ogw(runner.ws, ['command', id, 'get_state'], { env: { ...runner.ws.env, OGW_AGENT_KEY: key.value } });
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain('ogw command is not for the play agent');
    } finally {
      remove();
    }
    // a record that cannot be read is not "no agent": the command is not sent
    const unreadable = join(await jobsDir(runner.ws.env), 'agentbad1.json');
    writeFileSync(unreadable, '{');
    try {
      const run = await ogw(runner.ws, ['command', id, 'get_state'], { env: { ...runner.ws.env, OGW_AGENT_KEY: 'agentbad1.nonce' } });
      expect(run.code).not.toBe(0);
    } finally {
      rmSync(unreadable, { force: true });
    }
    expect(runner.requests('main')).toHaveLength(before);
  });

  it('refuses an instance in the input of a running play agent', async () => {
    const before = runner.requests('main').length;
    const remove = await fakeAgentJob(runner.ws.env, 'agentplay3', { role: 'play', cliPid: 999_999, instances: [id] });
    try {
      const run = await ogw(runner.ws, ['command', id, 'get_state']);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain(`instance ${id} is played by the running play agent agentplay3`);
    } finally {
      remove();
    }
    expect(runner.requests('main')).toHaveLength(before);
  });

  it('reads only the agents in the index of running agents, not every job record', async () => {
    const remove = await fakeAgentJob(runner.ws.env, 'agentplay4', { role: 'play', cliPid: 999_999, instances: [id] });
    rmSync(join(await jobsDir(runner.ws.env), 'running-agents', 'agentplay4'));
    try {
      expect((await ogw(runner.ws, ['command', id, 'get_state'])).code).toBe(0);
    } finally {
      remove();
    }
  });

  it('sends to an instance that only a running agent other than play and judge has in its input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-content-'));
    const input = join(dir, 'input.md');
    writeFileSync(input, 'content input');
    const content = await fakeAgentJob(runner.ws.env, 'agentcontent2', { role: 'content', cliPid: 999_999, input, instances: [id] });
    const before = runner.requests('main').length;
    try {
      expect(await ogw(runner.ws, ['command', id, 'shop.open_shop'])).toMatchObject({ code: 0, stdout: '{"ok":true,"result":{"opened":true}}\n' });
      expect(runner.requests('main').slice(before)).toMatchObject([{ command: 'shop.open_shop' }]);
    } finally {
      content();
    }
  });

  it('refuses an instance in the input of a running judge agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-judge-'));
    const input = join(dir, 'input.json');
    writeFileSync(input, JSON.stringify({ A: { instance: 'other' }, B: null, fixtures: [{ A: null, B: id }] }));
    const remove = await fakeAgentJob(runner.ws.env, 'agentjudge1', { role: 'judge', cliPid: 999_999, input, instances: ['other', id] });
    const other = await fakeAgentJob(runner.ws.env, 'agentcontent1', { role: 'content', cliPid: 999_999, input, instances: [id] });
    const play = await fakeAgentJob(runner.ws.env, 'agentplay2', { role: 'play', cliPid: 999_999, input, instances: ['other'] });
    try {
      const run = await ogw(runner.ws, ['command', id, 'get_state']);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain(`instance ${id} is played by the running judge agent agentjudge1`);
    } finally {
      remove();
      other();
      play();
    }
    expect((await ogw(runner.ws, ['command', id, 'get_state'])).code).toBe(0);
  });

  it('takes setup commands only with the full token; the play token takes input, capture, observation and step mode', async () => {
    const record = await readRecord(id, runner.ws.env);
    const play = await readPlayAccess(id, runner.ws.env);
    expect(play.port).toBe(record.control?.port);
    expect(play.token).not.toBe(record.control?.token);
    expect(play.clients).toEqual(['main']);
    const call = (token: string, path: string, body: Record<string, unknown>): Promise<unknown> => controlCall(play.port, token, path, body, 5000);
    const request = (command: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ client: 'main', command, args: [], timeoutMs: 2000, ...extra });
    for (const command of ['get_state', 'tap', 'capture_screen', 'extract_logs', 'get_telemetry']) {
      await expect(call(play.token, '/request', request(command))).resolves.toMatchObject({ ok: true });
    }
    await expect(call(play.token, '/stepping', { active: false })).resolves.toEqual({});
    const before = runner.requests('main').length;
    await expect(call(play.token, '/request', request('set_user_state'))).rejects.toThrow('the play access does not send set_user_state to main');
    await expect(call(play.token, '/request', request('shop.open_shop'))).rejects.toThrow('the play access does not send shop.open_shop to main');
    await expect(call(play.token, '/request', request('capture_video', { framesDir: join(tmpdir(), 'x') }))).rejects.toThrow('the play access does not take framesDir');
    await expect(call(play.token, '/restart', {})).rejects.toThrow('the play access does not allow /restart');
    await expect(call(play.token, '/stop', {})).rejects.toThrow('the play access does not allow /stop');
    await expect(call('wrong', '/request', request('get_state'))).rejects.toThrow('unauthorized');
    expect(runner.requests('main')).toHaveLength(before);
    await expect(call(record.control?.token ?? '', '/request', request('shop.open_shop'))).resolves.toMatchObject({ ok: true, result: { opened: true } });
    expect((await readRecord(id, runner.ws.env)).status).toBe('running');
  });
});
