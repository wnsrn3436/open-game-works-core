import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { span } from '../../../lib/spans.ts';
import { isNotFound } from '../../../lib/fsx.ts';
import { automationRequest } from '../../instance/automation.ts';
import type { CheckFailure, CheckResult } from '../api.ts';
import { parseDataTable } from '../static/lib/csv.ts';
import type { InstanceCheckOptions } from './bot-playtest.ts';
import { checkResult, failure } from './evidence.ts';
import { onInstance, withInstance } from './instances.ts';
import { shareUnits, UnitQueue, type SharedUnits } from './units.ts';

/**
 * Row simulation (`client-content` `## row simulation`): the calculation `ogw simulate` and
 * `ogw check --loop` share. Runs on an instance whose client reached `boot_stage` `Done`.
 */
export type Verdict = 'in' | 'out' | 'unsolvable' | 'error';

export interface Range {
  min: number | null;
  max: number | null;
}

export interface RowResult {
  table: string;
  /** ID name of the row. */
  id: string;
  /** 1-based line of the row in `data/tables/<table>.csv`. */
  line: number;
  verdict: Verdict;
  /** Row values: `solve_permille` and the median of each metric the command gave. */
  values: Record<string, number>;
  targets: Record<string, Range>;
  /** Why the verdict is not `in`; empty for `in`. */
  detail: string;
}

export interface RowSimulation {
  rows: RowResult[];
  /** Tables that were simulated: each has a `<feature>.simulate_<table>` command and a CSV. */
  tables: string[];
  /** Tables with `sim_` target columns but no `<feature>.simulate_<table>` command. */
  missing: string[];
}

export interface SimulateOptions {
  seeds: number;
  table?: string;
  rows?: string[];
}

interface Table {
  name: string;
  targets: Record<string, Range>;
  rows: { id: string; line: number; targets: Record<string, Range> }[];
}

const SIMULATE = /^[a-z][a-z0-9_]*\.simulate_([a-z][a-z0-9_]*)$/;
const TARGET = /^sim_(.+)_(min|max)$/;
/** A metric name of a command result: snake_case, not `solve_permille`. */
const METRIC = /^[a-z][a-z0-9_]*$/;

function cellInt(cell: string | undefined): number | null {
  if (cell === undefined || cell === '') return null;
  const value = Number(cell);
  return Number.isInteger(value) ? value : null;
}

/** Reads a table (`parseDataTable`): column names are header row 4; rows with an empty `id` are skipped. */
export function parseTable(name: string, text: string): Table {
  const data = parseDataTable(`data/tables/${name}.csv`, text);
  const names = data?.names ?? [];
  const columns: { metric: string; side: 'min' | 'max'; index: number }[] = [];
  names.forEach((column, index) => {
    const match = TARGET.exec(column);
    if (match) columns.push({ metric: match[1] as string, side: match[2] as 'min' | 'max', index });
  });
  const targets: Record<string, Range> = {};
  for (const c of columns) targets[c.metric] = { min: null, max: null };
  const rows = (data?.rows ?? []).flatMap((record) => {
    const id = record.cells[0] ?? '';
    if (id === '') return [];
    const rowTargets: Record<string, Range> = {};
    for (const c of columns) {
      rowTargets[c.metric] ??= { min: null, max: null };
      (rowTargets[c.metric] as Range)[c.side] = cellInt(record.cells[c.index]);
    }
    return [{ id, line: record.line, targets: rowTargets }];
  });
  return { name, targets, rows };
}

async function readTables(root: string): Promise<Map<string, Table>> {
  const dir = join(root, 'data', 'tables');
  const tables = new Map<string, Table>();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((file) => file.endsWith('.csv')).sort();
  } catch (error) {
    if (isNotFound(error)) return tables;
    throw error;
  }
  for (const file of files) {
    const name = file.slice(0, -'.csv'.length);
    tables.set(name, parseTable(name, await readFile(join(dir, file), 'utf8')));
  }
  return tables;
}

export interface SeedResult {
  solved: boolean;
  metrics: Record<string, number>;
}

function seedResult(value: unknown): SeedResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const { solved, metrics } = value as { solved?: unknown; metrics?: unknown };
  if (typeof solved !== 'boolean' || typeof metrics !== 'object' || metrics === null || Array.isArray(metrics)) return null;
  const entries = Object.entries(metrics as Record<string, unknown>);
  if (!entries.every(([k, v]) => METRIC.test(k) && k !== 'solve_permille' && typeof v === 'number' && Number.isInteger(v))) return null;
  return { solved, metrics: Object.fromEntries(entries) as Record<string, number> };
}

/** Median; with an even count, the smaller of the two middle values. */
export function lowerMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1] ?? 0;
}

/** Row values from the results of seed 1 to n. */
export function rowValues(results: readonly SeedResult[]): Record<string, number> {
  const solved = results.filter((r) => r.solved).length;
  const values: Record<string, number> = { solve_permille: Math.floor((solved * 1000) / results.length) };
  const metrics = new Set(results.flatMap((r) => Object.keys(r.metrics)));
  for (const metric of metrics) {
    const samples = results.map((r) => r.metrics[metric]).filter((v): v is number => v !== undefined);
    values[metric] = lowerMedian(samples);
  }
  return values;
}

/** The first verdict that holds among `unsolvable`, `out`, `in` (an `error` row is decided before). */
export function verdictOf(values: Record<string, number>, targets: Record<string, Range>): { verdict: Verdict; detail: string } {
  if (values.solve_permille === 0) return { verdict: 'unsolvable', detail: 'solve_permille 0' };
  const outside: string[] = [];
  for (const [metric, range] of Object.entries(targets)) {
    const value = values[metric] ?? 0;
    if ((range.min !== null && value < range.min) || (range.max !== null && value > range.max)) {
      outside.push(`${metric} ${String(value)} not in [${String(range.min)}, ${String(range.max)}]`);
    }
  }
  return outside.length > 0 ? { verdict: 'out', detail: outside.join(', ') } : { verdict: 'in', detail: '' };
}

/** Why the seeds of a row did not all give a result; `answered` is false when the request of a seed threw. */
interface SeedError {
  message: string;
  answered: boolean;
}

async function runSeeds(ctx: Context, id: string, command: string, row: string, seeds: number, required: string[]): Promise<SeedResult[] | SeedError> {
  const results: SeedResult[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const error = (message: string, answered = true): SeedError => ({ message: `seed ${String(seed)}: ${message}`, answered });
    let response: Awaited<ReturnType<typeof automationRequest>>;
    try {
      response = await automationRequest(ctx, id, command, [row, String(seed)]);
    } catch (thrown) {
      return error(`${command} did not answer: ${thrown instanceof Error ? thrown.message : String(thrown)}`, false);
    }
    if (!response.ok) return error(`${command} returned ok false: ${JSON.stringify(response.result)}`);
    const result = seedResult(response.result);
    if (result === null) return error('result is not {"solved": <bool>, "metrics": {"<snake_case metric, not solve_permille>": <integer>}}');
    const absent = required.filter((metric) => !(metric in result.metrics));
    if (absent.length > 0) return error(`metrics has no ${absent.join(', ')}`);
    results.push(result);
  }
  return results;
}

/** One row to simulate: the command of its table, the row and the metrics that have a target column in that table. */
interface RowUnit {
  command: string;
  table: Table;
  row: Table['rows'][number];
  required: string[];
}

/**
 * The verdict of one row from all its seeds, run in order on the instance `id`; `answered` is false when the request of
 * a seed threw (the client of the instance ended, hangs or closed its automation channel).
 */
async function simulateRow(ctx: Context, id: string, unit: RowUnit, seeds: number): Promise<{ result: RowResult; answered: boolean }> {
  const base = { table: unit.table.name, id: unit.row.id, line: unit.row.line, targets: unit.row.targets };
  const results = await runSeeds(ctx, id, unit.command, unit.row.id, seeds, unit.required);
  if (!Array.isArray(results)) return { result: { ...base, verdict: 'error', values: {}, detail: results.message }, answered: results.answered };
  const values = rowValues(results);
  return { result: { ...base, values, ...verdictOf(values, unit.row.targets) }, answered: true };
}

async function simulateCommands(ctx: Context, id: string): Promise<{ command: string; table: string }[]> {
  const listed = await automationRequest(ctx, id, 'list_commands', []);
  if (!listed.ok || !Array.isArray(listed.result)) throw new Error(`list_commands failed: ${JSON.stringify(listed.result)}`);
  return (listed.result as { name?: unknown }[]).flatMap((c) => {
    const match = typeof c.name === 'string' ? SIMULATE.exec(c.name) : null;
    return match ? [{ command: c.name as string, table: match[1] as string }] : [];
  });
}

/**
 * The rows that `simulateRows` runs, in the order of the commands and then of the rows of each table, with the tables
 * simulated and those that have `sim_` target columns but no command.
 */
function plannedRows(tables: ReadonlyMap<string, Table>, commands: readonly { command: string; table: string }[], options: SimulateOptions): { units: RowUnit[]; simulated: string[]; missing: string[] } {
  const chosen = commands.filter((c) => options.table === undefined || c.table === options.table);
  const units: RowUnit[] = [];
  const simulated: string[] = [];
  for (const { command, table } of chosen) {
    const data = tables.get(table);
    if (!data) continue;
    simulated.push(table);
    const required = Object.keys(data.targets).filter((metric) => metric !== 'solve_permille');
    const rows = options.rows ? data.rows.filter((row) => options.rows?.includes(row.id)) : data.rows;
    for (const row of rows) units.push({ command, table: data, row, required });
  }
  const commanded = new Set(chosen.map((c) => c.table));
  const missing = [...tables.values()]
    .filter((t) => Object.keys(t.targets).length > 0 && !commanded.has(t.name) && (options.table === undefined || t.name === options.table))
    .map((t) => t.name);
  return { units, simulated, missing };
}

/** Runs every `<feature>.simulate_<table>` command (or the one of `options.table`) on every row of its table. */
export async function simulateRows(ctx: Context, id: string, root: string, options: SimulateOptions): Promise<RowSimulation> {
  const plan = plannedRows(await readTables(root), await simulateCommands(ctx, id), options);
  const rows: RowResult[] = [];
  for (const unit of plan.units) rows.push((await simulateRow(ctx, id, unit, options.seeds)).result);
  return { rows, tables: plan.simulated, missing: plan.missing };
}

/** `row simulation` failures (ogw.md `## check`). */
export function rowSimulationFailures(simulation: RowSimulation): CheckFailure[] {
  const failures = simulation.rows
    .filter((row) => row.verdict !== 'in')
    .map((row) => failure(`data/tables/${row.table}.csv:${String(row.line)}`, `${row.verdict} ${row.id}: ${row.detail}`));
  for (const table of simulation.missing) {
    failures.push(failure(`data/tables/${table}.csv:1`, `error ${table} has sim_ target columns but no simulate_${table} command`));
  }
  return failures;
}

/** `where` (a file:line) of a row simulation that did not run: line 1 of the data table folder it reads. */
export const ROW_SIMULATION_WHERE = 'data/tables:1';

/**
 * Where the client of an instance stopped answering, in row order: that instance gives the rows from `from` on. `after`
 * is true when its first request after row `from - 1` threw and is not one of row `from` (the client may have ended
 * after it answered row `from - 1`), and false when a request of row `from` threw.
 */
interface Cut {
  from: number;
  after: boolean;
}

/** Whether `a` comes first on the runner alone: an end after row `r` comes before a request of row `r + 1` that throws. */
function comesFirst(a: Cut, b: Cut | null): boolean {
  return b === null || a.from < b.from || (a.from === b.from && a.after && !b.after);
}

/** The message of the error of `list_commands` on the instance `id`, or null when its client answers. */
async function silence(ctx: Context, id: string): Promise<string | null> {
  try {
    await automationRequest(ctx, id, 'list_commands', []);
    return null;
  } catch (thrown) {
    return thrown instanceof Error ? thrown.message : String(thrown);
  }
}

/**
 * `row simulation` of `ogw check --loop`: a headless instance apart from the bot playtest reads the commands and runs
 * the rows in order, and helper instances in free slots of the check run rows beside it (ogw.md `### spare slots` of
 * `## check`); each row runs all its seeds on one instance. The rows keep the order of `simulateRows`. The result is
 * that of the reading instance alone, on which each row meets the client that the row before it left: an instance whose
 * next row is not the one after its last row first checks that its client still answers. When a request of an instance
 * throws, that instance gives the rows after the last request it answered, in order, as the reading instance would
 * after that request, and what other instances gave for them is dropped.
 */
export async function rowSimulationCheck(ctx: Context, game: string, root: string, seeds: number, options: InstanceCheckOptions): Promise<CheckResult> {
  const instanceOptions = { game, client: 'headless' as const, db: options.db };
  const helpers: SharedUnits[] = [];
  try {
    const simulation = await withInstance(ctx, options.slots, instanceOptions, async (instance): Promise<RowSimulation> => {
      const plan = plannedRows(await readTables(root), await simulateCommands(ctx, instance.id), { seeds });
      const rows: RowResult[] = [];
      const simulate = (id: string, i: number): ReturnType<typeof simulateRow> => {
        const unit = plan.units[i] as RowUnit;
        return span(`row ${unit.table.name} ${unit.row.id}`, () => simulateRow(ctx, id, unit, seeds));
      };
      // the first cut on the runner alone: the rows from it on are those of its instance
      let cut: Cut | null = null;
      // the instance `id` gives the rows from `at.from` on, in order; `own` is its result of that row when a request of it threw
      const takeOver = async (id: string, at: Cut, own?: RowResult): Promise<void> => {
        if (!comesFirst(at, cut)) return;
        cut = at;
        shared.stopAfter(at.from - 1);
        let i = at.from;
        if (own !== undefined) rows[i++] = own;
        // until a cut that comes first is found on another instance, whose instance then gives these rows
        for (; i < plan.units.length && cut === at; i++) {
          const { result } = await simulate(id, i);
          if (cut === at) rows[i] = result;
        }
      };
      const runRows = async (id: string, next: () => number | null): Promise<void> => {
        let previous: number | null = null;
        for (;;) {
          const i = next();
          // another instance runs the row after `previous`, or none does after it here
          if (previous !== null && i !== previous + 1 && previous + 1 < plan.units.length) {
            const after: Cut = { from: previous + 1, after: true };
            const message = comesFirst(after, cut) ? await silence(ctx, id) : null;
            if (message !== null) {
              const unit = plan.units[previous] as RowUnit;
              ctx.log(`row simulation: instance ${id} did not answer after row ${unit.table.name} ${unit.row.id}: ${message}`);
              await takeOver(id, after);
              return;
            }
          }
          if (i === null) return;
          const { result, answered } = await simulate(id, i);
          if (!answered) {
            await takeOver(id, { from: i, after: false }, result);
            return;
          }
          if (cut === null || i < cut.from) rows[i] = result;
          previous = i;
        }
      };
      const shared = shareUnits(
        options.slots,
        new UnitQueue(plan.units.length),
        (next, signal) => onInstance(ctx, instanceOptions, (helper) => runRows(helper.id, next), options.evidence, signal),
        (error) => {
          ctx.log(`row simulation: a helper instance ended: ${(error as Error).message}`);
        },
      );
      helpers.push(shared);
      await runRows(instance.id, () => shared.claim());
      // the rows of the helpers are in `rows` once they end; this instance stops at once
      return { rows, tables: plan.simulated, missing: plan.missing };
    }, options.evidence);
    await Promise.all(helpers.map((h) => h.helpers()));
    return checkResult('row simulation', null, rowSimulationFailures(simulation));
  } catch (error) {
    await Promise.all(helpers.map((h) => h.helpers()));
    return checkResult('row simulation', null, [failure(ROW_SIMULATION_WHERE, `row simulation did not run: ${(error as Error).message}`)], true);
  }
}
