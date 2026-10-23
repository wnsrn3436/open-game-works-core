import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { isNotFound } from '../../../lib/fsx.ts';
import { automationRequest } from '../../instance/automation.ts';
import type { CheckFailure, CheckResult } from '../api.ts';
import { parseDataTable } from '../static/lib/csv.ts';
import type { InstanceCheckOptions } from './bot-playtest.ts';
import { checkResult, failure } from './evidence.ts';
import { withInstance } from './instances.ts';

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

async function runSeeds(ctx: Context, id: string, command: string, row: string, seeds: number, required: string[]): Promise<SeedResult[] | string> {
  const results: SeedResult[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    let response: Awaited<ReturnType<typeof automationRequest>>;
    try {
      response = await automationRequest(ctx, id, command, [row, String(seed)]);
    } catch (error) {
      return `seed ${String(seed)}: ${command} did not answer: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!response.ok) return `seed ${String(seed)}: ${command} returned ok false: ${JSON.stringify(response.result)}`;
    const result = seedResult(response.result);
    if (result === null) return `seed ${String(seed)}: result is not {"solved": <bool>, "metrics": {"<snake_case metric, not solve_permille>": <integer>}}`;
    const absent = required.filter((metric) => !(metric in result.metrics));
    if (absent.length > 0) return `seed ${String(seed)}: metrics has no ${absent.join(', ')}`;
    results.push(result);
  }
  return results;
}

async function simulateTable(ctx: Context, id: string, command: string, table: Table, options: SimulateOptions): Promise<RowResult[]> {
  const required = Object.keys(table.targets).filter((metric) => metric !== 'solve_permille');
  const rows = options.rows ? table.rows.filter((row) => options.rows?.includes(row.id)) : table.rows;
  const results: RowResult[] = [];
  for (const row of rows) {
    const base = { table: table.name, id: row.id, line: row.line, targets: row.targets };
    const seeds = await runSeeds(ctx, id, command, row.id, options.seeds, required);
    if (typeof seeds === 'string') {
      results.push({ ...base, verdict: 'error', values: {}, detail: seeds });
      continue;
    }
    const values = rowValues(seeds);
    results.push({ ...base, values, ...verdictOf(values, row.targets) });
  }
  return results;
}

async function simulateCommands(ctx: Context, id: string): Promise<{ command: string; table: string }[]> {
  const listed = await automationRequest(ctx, id, 'list_commands', []);
  if (!listed.ok || !Array.isArray(listed.result)) throw new Error(`list_commands failed: ${JSON.stringify(listed.result)}`);
  return (listed.result as { name?: unknown }[]).flatMap((c) => {
    const match = typeof c.name === 'string' ? SIMULATE.exec(c.name) : null;
    return match ? [{ command: c.name as string, table: match[1] as string }] : [];
  });
}

/** Runs every `<feature>.simulate_<table>` command (or the one of `options.table`) on every row of its table. */
export async function simulateRows(ctx: Context, id: string, root: string, options: SimulateOptions): Promise<RowSimulation> {
  const tables = await readTables(root);
  const commands = (await simulateCommands(ctx, id)).filter((c) => options.table === undefined || c.table === options.table);
  const rows: RowResult[] = [];
  const simulated: string[] = [];
  for (const { command, table } of commands) {
    const data = tables.get(table);
    if (!data) continue;
    simulated.push(table);
    rows.push(...(await simulateTable(ctx, id, command, data, options)));
  }
  const commanded = new Set(commands.map((c) => c.table));
  const missing = [...tables.values()]
    .filter((t) => Object.keys(t.targets).length > 0 && !commanded.has(t.name) && (options.table === undefined || t.name === options.table))
    .map((t) => t.name);
  return { rows, tables: simulated, missing };
}

/** `row simulation` failures (`game-loop` `## loop iteration record`). */
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

/** `row simulation` of `ogw check --loop`: a headless instance apart from the bot playtest. */
export async function rowSimulationCheck(ctx: Context, game: string, root: string, seeds: number, options: InstanceCheckOptions): Promise<CheckResult> {
  try {
    return await withInstance(ctx, options.slots, { game, client: 'headless', db: options.db }, async (instance) => {
      const simulation = await simulateRows(ctx, instance.id, root, { seeds });
      return checkResult('row simulation', null, rowSimulationFailures(simulation));
    }, options.evidence);
  } catch (error) {
    return checkResult('row simulation', null, [failure(ROW_SIMULATION_WHERE, `row simulation did not run: ${(error as Error).message}`)], true);
  }
}
