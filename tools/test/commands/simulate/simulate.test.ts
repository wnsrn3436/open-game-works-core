import { afterEach, describe, expect, it, vi } from 'vitest';
import { listRecords } from '../../../src/commands/instance/lib/records.ts';
import { ogw } from '../../helpers/workspace.ts';
import { setupRunner, stopAll, type Runner } from '../instance/runner.ts';

vi.mock('../../../src/commands/generate/api.ts', async () => (await import('../instance/mocks/apis.ts')).generate);
vi.mock('../../../src/commands/data/api.ts', async () => (await import('../instance/mocks/apis.ts')).data);
vi.mock('../../../src/commands/core/api.ts', async () => (await import('../instance/mocks/apis.ts')).core);
vi.mock('../../../src/commands/env/api.ts', async () => (await import('../instance/mocks/apis.ts')).env);
vi.mock('../../../src/commands/instance/lib/spawn.ts', () => import('../instance/mocks/spawn.ts'));
vi.mock('../../../src/commands/instance/lib/launch.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/commands/instance/lib/launch.ts')>();
  return { ...real, ...(await import('../instance/mocks/apis.ts')).launchOverrides(real) };
});

const LEVEL = ',,,\nAll,None,None,None\nid(key),int?,int?,int?\nid,sim_moves_left_min,sim_moves_left_max,sim_solve_permille_min\n[l1],1,null,500\n[l2],5,9,null\n';
const BOSS = ',,\nAll,None,None\nid(key),int?,int?\nid,sim_hp_min,sim_hp_max\n[b1],1,2\n';

let runner: Runner | null = null;

afterEach(async () => {
  if (runner) await stopAll(runner);
  runner = null;
});

describe('ogw simulate', () => {
  it('simulates each row on a headless instance and stops it', async () => {
    runner = setupRunner({ files: { 'data/tables/level.csv': LEVEL, 'data/tables/boss.csv': BOSS } });
    runner.config({
      clients: {
        main: {
          commands: ['puzzle.simulate_level', 'puzzle.other'],
          results: { 'puzzle.simulate_level': { ok: true, result: { solved: true, metrics: { moves_left: 3 } } } },
        },
      },
    });
    const run = await ogw(runner.ws, ['simulate', 'g', '--seeds', '2']);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe(
      [
        'level [l1]: in solve_permille=1000 moves_left=3 moves_left[1,] solve_permille[500,]',
        'level [l2]: out solve_permille=1000 moves_left=3 moves_left[5,9] (moves_left 3 not in [5, 9])',
        'no simulate command: boss',
        '',
      ].join('\n'),
    );
    expect(runner.clientArgs('main')).toContain('--headless');
    const calls = runner.requests('main').filter((r) => r.command === 'puzzle.simulate_level').map((r) => r.args);
    expect(calls).toEqual([['[l1]', '1'], ['[l1]', '2'], ['[l2]', '1'], ['[l2]', '2']]);
    expect(await listRecords(runner.ws.env)).toEqual([]);
  });

  it('takes --table, --rows and the seeds of game settings', async () => {
    runner = setupRunner({ files: { 'data/tables/level.csv': LEVEL }, settings: { rowSimulationSeeds: 3 } });
    runner.config({
      clients: { main: { commands: ['puzzle.simulate_level'], results: { 'puzzle.simulate_level': { ok: true, result: { solved: true, metrics: { moves_left: 6 } } } } } },
    });
    const run = await ogw(runner.ws, ['simulate', 'g', '--table', 'level', '--rows', '[l2]']);
    expect(run).toMatchObject({ code: 0, stdout: 'level [l2]: in solve_permille=1000 moves_left=6 moves_left[5,9]\n' });
    expect(runner.requests('main').filter((r) => r.command === 'puzzle.simulate_level')).toHaveLength(3);
    expect((await ogw(runner.ws, ['simulate', 'g', '--seeds', '0'])).stderr).toContain('invalid --seeds: 0');
  });

  it('fails when an asked table or row is not simulated, or a table has no command', async () => {
    runner = setupRunner({ files: { 'data/tables/level.csv': LEVEL, 'data/tables/boss.csv': BOSS } });
    runner.config({
      clients: { main: { commands: ['puzzle.simulate_level'], results: { 'puzzle.simulate_level': { ok: true, result: { solved: true, metrics: { moves_left: 6 } } } } } },
    });
    const typo = await ogw(runner.ws, ['simulate', 'g', '--table', 'level', '--rows', '[l2],[lv_typo]', '--seeds', '1']);
    expect(typo).toMatchObject({
      code: 1,
      stdout: 'level [l2]: in solve_permille=1000 moves_left=6 moves_left[5,9]\nrow not simulated: [lv_typo] is not a row of a simulated table\n',
    });
    const table = await ogw(runner.ws, ['simulate', 'g', '--table', 'levle', '--seeds', '1']);
    expect(table).toMatchObject({ code: 1, stdout: 'table not simulated: levle has no simulate command or no data/tables/levle.csv\n' });
    const boss = await ogw(runner.ws, ['simulate', 'g', '--table', 'boss', '--seeds', '1']);
    expect(boss).toMatchObject({ code: 1, stdout: 'no simulate command: boss\n' });
  });
});
