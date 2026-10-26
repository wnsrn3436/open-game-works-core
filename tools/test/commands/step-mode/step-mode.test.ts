import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ogw } from '../../helpers/workspace.ts';
import { mockState } from '../instance/mocks/state.ts';
import { MATCH_MODE_HEADER, setupRunner, startFor, stopAll, type Runner } from '../instance/runner.ts';

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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (client: string, command: string) => runner.requests(client).filter((r) => r.command === command).length;
const commands = (client: string) => runner.requests(client).map((r) => r.command);

beforeAll(async () => {
  runner = setupRunner({ files: { 'data/tables/match_mode.csv': `${MATCH_MODE_HEADER}[duel],2,2,1,true,false\n` } });
  mockState.modules = { client: ['RealtimeCore'], server: [] };
  runner.config({ clients: { default: { commands: ['battle.opponent_step'] } } });
  id = await startFor(runner);
});

afterAll(async () => {
  await stopAll(runner);
});

describe('ogw step-mode and ogw step', () => {
  it('turns step mode on for the client and each opponent bot client, and holds the bot loop', async () => {
    const run = await ogw(runner.ws, ['step-mode', id, 'on']);
    expect(run).toMatchObject({ code: 0, stdout: 'step mode on\n' });
    expect(runner.requests('main').at(-1)).toMatchObject({ command: 'set_step_mode', args: ['on'] });
    const bot = commands('opponent_1');
    expect(bot.slice(bot.lastIndexOf('leave_match'))).toEqual(['leave_match', 'set_step_mode']);
    await wait(300);
    const held = count('opponent_1', 'battle.opponent_step');
    await wait(600);
    expect(count('opponent_1', 'battle.opponent_step')).toBe(held);
  });

  it('steps every client in step mode, and the bot loop runs while stepping', async () => {
    runner.config({ clients: { default: { commands: ['battle.opponent_step'], delayMs: { step: 400 } } } });
    const before = count('opponent_1', 'battle.opponent_step');
    const run = await ogw(runner.ws, ['step', id, '100']);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^step 1\/1: advanced 100 ms: main, opponent_1: device ms [0-9]+\n$/);
    expect(runner.requests('main').slice(-2)).toMatchObject([{ command: 'step', args: ['100'] }, { command: 'get_telemetry' }]);
    expect(runner.requests('opponent_1').some((r) => r.command === 'step' && r.args[0] === '100')).toBe(true);
    expect(count('opponent_1', 'battle.opponent_step')).toBeGreaterThan(before);
  });

  it('steps only the client in a Playing match', async () => {
    runner.config({ clients: { default: { commands: ['battle.opponent_step'] }, main: { stateNow: { match_state: 'Playing' } } } });
    const steps = count('opponent_1', 'step');
    const run = await ogw(runner.ws, ['step', id, '50']);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^step 1\/1: advanced 50 ms: main: device ms [0-9]+\n$/);
    expect(count('opponent_1', 'step')).toBe(steps);
  });

  it('fails when a step fails or the ms is invalid', async () => {
    runner.config({ clients: { default: { commands: ['battle.opponent_step'] }, opponent_1: { fail: { step: 'budget' } } } });
    const run = await ogw(runner.ws, ['step', id, '50']);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('step 1/1: opponent_1: step failed: "budget"\n');
    expect((await ogw(runner.ws, ['step', id, '0'])).stderr).toContain('invalid ms: 0');
    expect((await ogw(runner.ws, ['step', id, '1.5'])).stderr).toContain('invalid ms: 1.5');
  });

  it('reverts set_step_mode when an opponent bot client fails, and turns step mode off', async () => {
    runner.config({ clients: { default: { commands: ['battle.opponent_step'] }, opponent_1: { fail: { set_step_mode: 'in match' } } } });
    const failed = await ogw(runner.ws, ['step-mode', id, 'off']);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('opponent_1: set_step_mode failed: "in match"');
    expect(runner.requests('main').slice(-2)).toMatchObject([{ args: ['off'] }, { command: 'set_step_mode', args: ['on'] }]);
    runner.config({ clients: { default: { commands: ['battle.opponent_step'] } } });
    expect((await ogw(runner.ws, ['step-mode', id, 'off'])).code).toBe(0);
    const before = count('opponent_1', 'battle.opponent_step');
    await wait(700);
    expect(count('opponent_1', 'battle.opponent_step')).toBeGreaterThan(before);
    const none = await ogw(runner.ws, ['step', id, '10']);
    expect(none.stderr).toContain('no client is in step mode');
  });

  it('fails without changing anything when the client refuses, and on a bad value', async () => {
    runner.config({ clients: { main: { fail: { set_step_mode: 'match' } } } });
    const before = runner.requests('opponent_1').length;
    const run = await ogw(runner.ws, ['step-mode', id, 'on']);
    expect(run.stderr).toContain('main: set_step_mode failed: "match"');
    expect(commands('opponent_1').slice(before)).not.toContain('set_step_mode');
    expect((await ogw(runner.ws, ['step-mode', id, 'maybe'])).stderr).toContain('usage: ogw step-mode <instance> <on|off>');
  });
});
