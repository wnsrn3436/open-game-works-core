import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { isNotFound } from '../../../lib/fsx.ts';
import { automationRequest } from '../../instance/automation.ts';
import { parseDataTable } from '../static/lib/csv.ts';

/**
 * Row simulation (`client-content` `## row simulation`): the calculation of `ogw simulate`. Runs on an instance whose
 * client reached `boot_stage` `Done`.
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

/** The results of seed 1 to `seeds` of a row, or why they did not all give one. */
async function runSeeds(ctx: Context, id: string, command: string, row: string, seeds: number, required: string[]): Promise<SeedResult[] | string> {
  const results: SeedResult[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const error = (message: string): string => `seed ${String(seed)}: ${message}`;
    let response: Awaited<ReturnType<typeof automationRequest>>;
    try {
      response = await automationRequest(ctx, id, command, [row, String(seed)]);
    } catch (thrown) {
      return error(`${command} did not answer: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
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

/** The verdict of one row from all its seeds, run in order on the instance `id`. */
async function simulateRow(ctx: Context, id: string, unit: RowUnit, seeds: number): Promise<RowResult> {
  const base = { table: unit.table.name, id: unit.row.id, line: unit.row.line, targets: unit.row.targets };
  const results = await runSeeds(ctx, id, unit.command, unit.row.id, seeds, unit.required);
  if (!Array.isArray(results)) return { ...base, verdict: 'error', values: {}, detail: results };
  const values = rowValues(results);
  return { ...base, values, ...verdictOf(values, unit.row.targets) };
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
  for (const unit of plan.units) rows.push(await simulateRow(ctx, id, unit, options.seeds));
  return { rows, tables: plan.simulated, missing: plan.missing };
}
