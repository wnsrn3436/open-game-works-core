import { expectPositionals, positional, str, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { LIMITS } from '../../lib/limits.ts';
import { loadGameSettings, loadSchema, schemaPath, withDefaults } from '../../lib/settings.ts';
import { simulateRows, type RowSimulation } from '../check/api.ts';
import { startInstance, stopInstance } from '../instance/api.ts';
import { START_LIMIT_MS } from '../instance/lib/supervisor.ts';

async function defaultSeeds(ctx: Context, root: string): Promise<number> {
  const settings = withDefaults(await loadSchema(schemaPath('game-settings', ctx.env)), await loadGameSettings(root));
  const seeds = settings.rowSimulationSeeds;
  if (typeof seeds !== 'number') throw new OgwError('game settings has no rowSimulationSeeds');
  return seeds;
}

function seedsOption(given: string | undefined): number | undefined {
  if (given === undefined) return undefined;
  if (!/^[0-9]+$/.test(given) || Number(given) < 1) throw new OgwError(`invalid --seeds: ${given}`);
  return Number(given);
}

function range(value: number | null): string {
  return value === null ? '' : String(value);
}

/** One line per row: values, target ranges and verdict; then the tables without a simulate command. */
export function formatSimulation(simulation: RowSimulation): string {
  const lines = simulation.rows.map((row) => {
    const values = Object.entries(row.values).map(([metric, value]) => `${metric}=${String(value)}`);
    const targets = Object.entries(row.targets)
      .filter(([, t]) => t.min !== null || t.max !== null)
      .map(([metric, t]) => `${metric}[${range(t.min)},${range(t.max)}]`);
    const detail = row.detail === '' ? [] : [`(${row.detail})`];
    return [`${row.table} ${row.id}: ${row.verdict}`, ...values, ...targets, ...detail].join(' ');
  });
  for (const table of simulation.missing) lines.push(`no simulate command: ${table}`);
  return lines.join('\n');
}

/** Lines for the asked `--table` and `--rows` that no simulate command ran. */
export function notSimulatedOf(simulation: RowSimulation, table: string | undefined, rows: readonly string[] | undefined): string[] {
  const lines: string[] = [];
  if (table !== undefined && !simulation.tables.includes(table) && !simulation.missing.includes(table)) {
    lines.push(`table not simulated: ${table} has no simulate command or no data/tables/${table}.csv`);
  }
  const ids = new Set(simulation.rows.map((r) => r.id));
  for (const id of rows ?? []) if (!ids.has(id)) lines.push(`row not simulated: ${id} is not a row of a simulated table`);
  return lines;
}

export const simulate: CommandDef = {
  name: ['simulate'],
  usage: 'ogw simulate <game> [--table <table>] [--rows <ID name>,...] [--seeds <n>]',
  options: { table: { type: 'string' }, rows: { type: 'string' }, seeds: { type: 'string' } },
  background: {
    game: (args) => args.positionals[0] ?? null,
    timeLimitMs: (_args, settings) => settings.instanceWaitTimeoutMs + START_LIMIT_MS + LIMITS.jobMs,
  },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const gameName = positional(args, 0, 'game');
    const rows = str(args, 'rows')?.split(',').filter((r) => r !== '');
    const given = seedsOption(str(args, 'seeds'));
    const game = await ctx.game(gameName);
    const seeds = given ?? (await defaultSeeds(ctx, game.root));
    const instance = await startInstance(ctx, { game: gameName, client: 'headless' });
    try {
      const table = str(args, 'table');
      const simulation = await simulateRows(ctx, instance.id, instance.root, { table, rows, seeds });
      const notSimulated = notSimulatedOf(simulation, table, rows);
      const pass = simulation.rows.every((r) => r.verdict === 'in') && simulation.missing.length === 0 && notSimulated.length === 0;
      const text = [formatSimulation(simulation), ...notSimulated].filter((l) => l !== '').join('\n');
      return { exitCode: pass ? 0 : 1, text, data: { ...simulation, notSimulated } };
    } finally {
      await stopInstance(ctx, instance.id);
    }
  },
};
