import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { automationRequest } from '../../../../src/commands/instance/automation.ts';
import { listInstances, startInstance, stopInstance } from '../../../../src/commands/instance/api.ts';
import {
  lowerMedian,
  parseTable,
  rowSimulationCheck,
  rowSimulationFailures,
  rowValues,
  simulateRows,
  verdictOf,
} from '../../../../src/commands/check/lib/row-simulation.ts';
import { Slots } from '../../../../src/commands/check/lib/instances.ts';
import { OgwError } from '../../../../src/lib/errors.ts';
import { fakeAutomation, fakeContext, notOk, ok } from '../helpers.ts';

vi.mock('../../../../src/commands/instance/automation.ts', () => ({ automationRequest: vi.fn() }));
vi.mock('../../../../src/commands/instance/api.ts', () => ({ startInstance: vi.fn(), stopInstance: vi.fn(), listInstances: vi.fn() }));

const ctx = fakeContext();

const LEVEL = [
  'desc,,,,',
  'All,All,None,None,None',
  'id(key),int,int?,int?,int?',
  'id,moves,sim_moves_left_min,sim_moves_left_max,sim_solve_permille_min',
  '[lv_1],10,2,5,500',
  '#[lv_x],10,,,',
  '"[lv_2]",10,,,',
  '',
].join('\n');

function gameRoot(tables: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ogw-rowsim-'));
  mkdirSync(join(root, 'data', 'tables'), { recursive: true });
  for (const [name, text] of Object.entries(tables)) writeFileSync(join(root, 'data', 'tables', `${name}.csv`), text);
  writeFileSync(join(root, 'data', 'tables', 'notes.txt'), 'not a table');
  return root;
}

const commands = [{ name: 'get_state' }, { name: 'puzzle.simulate_level' }, { name: 'puzzle.open_board' }, { name: 3 }];

beforeEach(() => {
  vi.mocked(automationRequest).mockReset();
  vi.mocked(listInstances).mockResolvedValue([]);
});

describe('row simulation calculation', () => {
  it('parseTable reads target columns per row and skips # rows', () => {
    const table = parseTable('level', LEVEL);
    expect(table.targets).toEqual({ moves_left: { min: null, max: null }, solve_permille: { min: null, max: null } });
    expect(table.rows).toEqual([
      { id: '[lv_1]', line: 5, targets: { moves_left: { min: 2, max: 5 }, solve_permille: { min: 500, max: null } } },
      { id: '[lv_2]', line: 7, targets: { moves_left: { min: null, max: null }, solve_permille: { min: null, max: null } } },
    ]);
    expect(parseTable('x', 'a\nb\nc\nid,sim_bad_min\n[r],1.5\n').rows[0]?.targets).toEqual({ bad: { min: null, max: null } });
    expect(parseTable('x', '').rows).toEqual([]);
    const blankHeaderLine = parseTable('x', 'desc\n\nAll\nid,sim_x_min\n[r],1\n');
    expect([blankHeaderLine.targets, blankHeaderLine.rows.map((r) => r.line)]).toEqual([{ x: { min: null, max: null } }, [5]]);
  });

  it('lowerMedian takes the smaller middle value', () => {
    expect(lowerMedian([5, 1, 3])).toBe(3);
    expect(lowerMedian([4, 1, 3, 2])).toBe(2);
    expect(lowerMedian([])).toBe(0);
  });

  it('rowValues: solve_permille rounds down; metrics are medians', () => {
    const results: { solved: boolean; metrics: Record<string, number> }[] = [
      { solved: true, metrics: { moves_left: 3 } },
      { solved: false, metrics: { moves_left: 0 } },
      { solved: true, metrics: { moves_left: 7, extra: 1 } },
    ];
    expect(rowValues(results)).toEqual({ solve_permille: 666, moves_left: 3, extra: 1 });
  });

  it('verdictOf: unsolvable, out on either side, in', () => {
    const targets = { moves_left: { min: 2, max: 5 } };
    expect(verdictOf({ solve_permille: 0, moves_left: 3 }, targets)).toEqual({ verdict: 'unsolvable', detail: 'solve_permille 0' });
    expect(verdictOf({ solve_permille: 1, moves_left: 1 }, targets)).toEqual({ verdict: 'out', detail: 'moves_left 1 not in [2, 5]' });
    expect(verdictOf({ solve_permille: 1, moves_left: 6 }, targets)).toEqual({ verdict: 'out', detail: 'moves_left 6 not in [2, 5]' });
    expect(verdictOf({ solve_permille: 1, moves_left: 2 }, targets)).toEqual({ verdict: 'in', detail: '' });
    expect(verdictOf({ solve_permille: 1, moves_left: 5 }, targets)).toEqual({ verdict: 'in', detail: '' });
    expect(verdictOf({ solve_permille: 1 }, { m: { min: null, max: null } })).toEqual({ verdict: 'in', detail: '' });
  });
});

describe('simulateRows', () => {
  it('calls the command per row and seed and judges each row', async () => {
    const root = gameRoot({ level: LEVEL, shop: 'a\nb\nc\nid,price\n[s],1\n', bonus: 'a\nb\nc\nid,sim_score_max\n[b],3\n' });
    const seen: string[] = [];
    vi.mocked(automationRequest).mockImplementation(fakeAutomation((command, args) => {
      if (command === 'list_commands') return ok(commands);
      seen.push(`${command} ${args.join(' ')}`);
      const seed = Number(args[1]);
      if (args[0] === '[lv_1]') return ok({ solved: seed !== 2, metrics: { moves_left: seed + 1 } });
      return ok({ solved: false, metrics: { moves_left: 0 } });
    }));
    const simulation = await simulateRows(ctx, 'i1', root, { seeds: 3 });
    expect(seen).toEqual([
      'puzzle.simulate_level [lv_1] 1',
      'puzzle.simulate_level [lv_1] 2',
      'puzzle.simulate_level [lv_1] 3',
      'puzzle.simulate_level [lv_2] 1',
      'puzzle.simulate_level [lv_2] 2',
      'puzzle.simulate_level [lv_2] 3',
    ]);
    expect(simulation.rows.map((r) => [r.id, r.verdict, r.values, r.detail])).toEqual([
      ['[lv_1]', 'in', { solve_permille: 666, moves_left: 3 }, ''],
      ['[lv_2]', 'unsolvable', { solve_permille: 0, moves_left: 0 }, 'solve_permille 0'],
    ]);
    expect(simulation.missing).toEqual(['bonus']);
    expect(rowSimulationFailures(simulation)).toEqual([
      { where: 'data/tables/level.csv:7', message: 'unsolvable [lv_2]: solve_permille 0', evidence: [] },
      { where: 'data/tables/bonus.csv:1', message: 'error bonus has sim_ target columns but no simulate_bonus command', evidence: [] },
    ]);
  });

  it('filters by table and rows', async () => {
    const root = gameRoot({ level: LEVEL, bonus: 'a\nb\nc\nid,sim_score_max\n[b],3\n' });
    vi.mocked(automationRequest).mockImplementation(
      fakeAutomation((command) => (command === 'list_commands' ? ok(commands) : ok({ solved: true, metrics: { moves_left: 3 } }))),
    );
    const level = await simulateRows(ctx, 'i1', root, { seeds: 1, table: 'level', rows: ['[lv_2]'] });
    expect(level).toEqual({
      rows: [{ table: 'level', id: '[lv_2]', line: 7, verdict: 'in', values: { solve_permille: 1000, moves_left: 3 }, targets: expect.any(Object) as object, detail: '' }],
      tables: ['level'],
      missing: [],
    });
    expect((await simulateRows(ctx, 'i1', root, { seeds: 1, table: 'bonus' })).missing).toEqual(['bonus']);
  });

  it('error rows: ok false, no answer in time, another result form, a target metric missing', async () => {
    const root = gameRoot({ level: LEVEL });
    const answer = (value: Awaited<ReturnType<typeof automationRequest>>): void => {
      vi.mocked(automationRequest).mockImplementation(fakeAutomation((command) => (command === 'list_commands' ? ok(commands) : value)));
    };
    const detail = async (): Promise<string | undefined> => (await simulateRows(ctx, 'i1', root, { seeds: 2, rows: ['[lv_1]'] })).rows[0]?.detail;
    answer(notOk('boom'));
    expect(await detail()).toBe('seed 1: puzzle.simulate_level returned ok false: "boom"');
    const bads = [
      null,
      5,
      { solved: 1, metrics: {} },
      { solved: true, metrics: [] },
      { solved: true },
      { solved: true, metrics: { a: 1.5 } },
      { solved: false, metrics: { moves_left: 3, solve_permille: 1000 } },
      { solved: true, metrics: { moves_left: 3, 'Moves-Left': 1 } },
    ];
    for (const bad of bads) {
      answer(ok(bad));
      expect(await detail()).toBe('seed 1: result is not {"solved": <bool>, "metrics": {"<snake_case metric, not solve_permille>": <integer>}}');
    }
    const outcome = await simulateRows(ctx, 'i1', root, { seeds: 1, rows: ['[lv_1]'] });
    expect(outcome.rows[0]?.verdict).toBe('error');
    let calls = 0;
    vi.mocked(automationRequest).mockImplementation((_c, _i, command) => {
      if (command === 'list_commands') return Promise.resolve(ok(commands));
      calls++;
      if (calls === 1) return Promise.reject(new Error('instance control /request timed out after 1000 ms'));
      return Promise.resolve(ok({ solved: true, metrics: { moves_left: 3 } }));
    });
    const timedOut = await simulateRows(ctx, 'i1', root, { seeds: 1 });
    expect(timedOut.rows.map((r) => [r.id, r.verdict, r.detail])).toEqual([
      ['[lv_1]', 'error', 'seed 1: puzzle.simulate_level did not answer: instance control /request timed out after 1000 ms'],
      ['[lv_2]', 'in', ''],
    ]);
    answer(ok({ solved: true, metrics: { other: 1 } }));
    expect(await detail()).toBe('seed 1: metrics has no moves_left');
  });

  it('fails when list_commands fails and reads no tables when there is no data/tables', async () => {
    vi.mocked(automationRequest).mockResolvedValue(notOk('x'));
    await expect(simulateRows(ctx, 'i1', gameRoot({}), { seeds: 1 })).rejects.toThrow('list_commands failed: "x"');
    vi.mocked(automationRequest).mockResolvedValue(ok([]));
    expect(await simulateRows(ctx, 'i1', mkdtempSync(join(tmpdir(), 'ogw-empty-')), { seeds: 1 })).toEqual({ rows: [], tables: [], missing: [] });
  });
});

describe('rowSimulationCheck', () => {
  const evidence = { root: '/tmp', dir: null, relative: true };

  it('runs on a headless instance and stops it', async () => {
    vi.mocked(startInstance).mockResolvedValue({ id: 'r1' } as Awaited<ReturnType<typeof startInstance>>);
    vi.mocked(stopInstance).mockResolvedValue();
    vi.mocked(automationRequest).mockImplementation(fakeAutomation((command) => (command === 'list_commands' ? ok(commands) : ok({ solved: true, metrics: { moves_left: 9 } }))));
    const result = await rowSimulationCheck(ctx, 'g', gameRoot({ level: LEVEL }), 2, { evidence, slots: new Slots(1), db: 'postgresql', pollMs: 1 });
    expect(startInstance).toHaveBeenCalledWith(ctx, { game: 'g', client: 'headless', db: 'postgresql', randomBase: 1n }, { beforeFailedStop: expect.any(Function) as unknown });
    expect(stopInstance).toHaveBeenCalledWith(ctx, 'r1');
    expect(result).toEqual({
      name: 'row simulation',
      platform: null,
      result: 'fail',
      failures: [{ where: 'data/tables/level.csv:5', message: 'out [lv_1]: moves_left 9 not in [2, 5]', evidence: [] }],
      warnings: [],
    });
    vi.mocked(automationRequest).mockImplementation(fakeAutomation((command) => (command === 'list_commands' ? ok([]) : ok(null))));
    expect((await rowSimulationCheck(ctx, 'g', gameRoot({}), 2, { evidence, slots: new Slots(1), pollMs: 1 })).result).toBe('pass');
  });

  it('runs rows on helper instances in free slots of the check, each row with all its seeds on one instance, in row order', async () => {
    const rowsCsv = ['desc,,', 'All,All,None', 'id(key),int,int?', 'id,moves,sim_moves_left_max', ...Array.from({ length: 6 }, (_, i) => `[lv_${String(i + 1)}],10,${String(i)}`), ''].join('\n');
    let n = 0;
    vi.mocked(startInstance).mockImplementation(() => Promise.resolve({ id: `r${String(++n)}` } as Awaited<ReturnType<typeof startInstance>>));
    vi.mocked(stopInstance).mockResolvedValue();
    const seen: { id: string; row: string; seed: string; start: number; end: number }[] = [];
    vi.mocked(automationRequest).mockImplementation(async (_c, id, command, args) => {
      if (command === 'list_commands') return ok(commands);
      const start = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push({ id, row: args[0] ?? '', seed: args[1] ?? '', start, end: Date.now() });
      // the moves left are the row number, one more than the max of the row: every row is out
      return ok({ solved: true, metrics: { moves_left: Number(/\d+/.exec(args[0] ?? '')?.[0]) } });
    });
    const run = (slots: Slots): ReturnType<typeof rowSimulationCheck> => rowSimulationCheck(ctx, 'g', gameRoot({ level: rowsCsv }), 3, { evidence, slots, pollMs: 1 });
    const one = await run(new Slots(1));
    expect(new Set(seen.map((s) => s.id))).toEqual(new Set(['r1']));
    seen.length = 0;
    n = 0;
    const three = await run(new Slots(3));
    expect(three).toEqual(one);
    expect(one.failures.map((f) => f.where)).toEqual(['data/tables/level.csv:5', 'data/tables/level.csv:6', 'data/tables/level.csv:7', 'data/tables/level.csv:8', 'data/tables/level.csv:9', 'data/tables/level.csv:10']);
    // three instances ran rows at once; each row ran its three seeds in order on one instance
    expect(new Set(seen.map((s) => s.id))).toEqual(new Set(['r1', 'r2', 'r3']));
    expect(Math.max(...seen.map((s) => new Set(seen.filter((o) => o.start <= s.start && s.start < o.end).map((o) => o.id)).size))).toBe(3);
    for (const row of new Set(seen.map((s) => s.row))) {
      const runs = seen.filter((s) => s.row === row);
      expect(new Set(runs.map((s) => s.id)).size).toBe(1);
      expect(runs.map((s) => s.seed)).toEqual(['1', '2', '3']);
    }
  });

  it('gives the rows after one whose client stops answering the result of one instance that runs them all, whatever the free slots', async () => {
    const rowsCsv = ['desc,,', 'All,All,None', 'id(key),int,int?', 'id,moves,sim_moves_left_max', ...Array.from({ length: 6 }, (_, i) => `[lv_${String(i + 1)}],10,10`), ''].join('\n');
    let n = 0;
    vi.mocked(startInstance).mockImplementation(() => Promise.resolve({ id: `r${String(++n)}` } as Awaited<ReturnType<typeof startInstance>>));
    vi.mocked(stopInstance).mockResolvedValue();
    // the command of [lv_2] ends the client of its instance after 5 ms: no request to that instance answers after it,
    // and each fails at once, sooner than a row of another instance (30 ms)
    const ended = new Set<string>();
    const requests: { id: string; row: string; live: boolean }[] = [];
    vi.mocked(automationRequest).mockImplementation(async (_c, id, command, args) => {
      if (command === 'list_commands') return ok(commands);
      const row = args[0] ?? '';
      requests.push({ id, row, live: !ended.has(id) });
      if (ended.has(id)) throw new OgwError('the client of the instance does not answer');
      await new Promise((resolve) => setTimeout(resolve, row === '[lv_2]' ? 5 : 30));
      if (row === '[lv_2]') ended.add(id);
      if (ended.has(id)) throw new OgwError('the client of the instance does not answer');
      return ok({ solved: true, metrics: { moves_left: 1 } });
    });
    const run = (slots: Slots): ReturnType<typeof rowSimulationCheck> => rowSimulationCheck(ctx, 'g', gameRoot({ level: rowsCsv }), 1, { evidence, slots, pollMs: 1 });
    const one = await run(new Slots(1));
    expect(one.failures.map((f) => f.where)).toEqual([6, 7, 8, 9, 10].map((line) => `data/tables/level.csv:${String(line)}`));
    expect(one.failures[1]?.message).toBe('error [lv_3]: seed 1: puzzle.simulate_level did not answer: the client of the instance does not answer');
    for (const slots of [2, 3]) {
      n = 0;
      ended.clear();
      requests.length = 0;
      expect(await run(new Slots(slots))).toEqual(one);
      expect(new Set(requests.map((r) => r.id)).size).toBe(slots);
      // no instance takes a row after the one whose client ended but the instance of that row
      expect(requests.filter((r) => ['[lv_4]', '[lv_5]', '[lv_6]'].includes(r.row) && r.live)).toEqual([]);
    }
  });

  it('is unknown when the instance does not start', async () => {
    vi.mocked(startInstance).mockRejectedValue(new Error('no slot'));
    expect(await rowSimulationCheck(ctx, 'g', gameRoot({}), 2, { evidence, slots: new Slots(1), pollMs: 1 })).toEqual({
      name: 'row simulation',
      platform: null,
      result: 'unknown',
      failures: [{ where: 'data/tables:1', message: 'row simulation did not run: no slot', evidence: [] }],
      warnings: [],
    });
  });
});
