import { join } from 'node:path';
import { expectPositionals, positional, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { writeFileAtomic } from '../../lib/fsx.ts';
import type { GenerationMethod, MeasuredStep } from '../../lib/settings.ts';
import { loadSchema, schemaPath } from '../../lib/settings.ts';

export type TypeStatus = 'ok' | 'unmeasured' | 'missing';

export interface TypeRow {
  type: string;
  status: TypeStatus;
  methods: { name: string; step: MeasuredStep }[];
  count: number | null;
  timeMs: number | null;
}

/** Resource type values of harness settings schema `resourceTypes`. */
export async function schemaResourceTypes(env: NodeJS.ProcessEnv): Promise<string[]> {
  const schema = (await loadSchema(schemaPath('harness-settings', env))) as {
    $defs?: { generationMethod?: { properties?: { resourceTypes?: { items?: { enum?: string[] } } } } };
  };
  return schema.$defs?.generationMethod?.properties?.resourceTypes?.items?.enum ?? [];
}

function lastOk(method: GenerationMethod): MeasuredStep | null {
  return (method.measured ?? []).filter((s) => s.result === 'ok').at(-1) ?? null;
}

/** `game-setup` 6: status of a type and its methods with an `ok` step. */
export function typeRow(type: string, methods: readonly GenerationMethod[], count: number | null): TypeRow {
  const own = methods.filter((m) => m.resourceTypes.includes(type));
  const withOk = own.flatMap((m) => {
    const step = lastOk(m);
    return step ? [{ name: m.name, step }] : [];
  });
  const status: TypeStatus = withOk.length > 0 ? 'ok' : own.some((m) => m.measured === undefined) ? 'unmeasured' : 'missing';
  const timeMs = status === 'ok' && count !== null ? Math.min(...withOk.map((m) => count * (m.step.jobMs ?? 0))) : null;
  return { type, status, methods: withOk, count: status === 'ok' ? count : null, timeMs };
}

function methodCell(m: { name: string; step: MeasuredStep }): string {
  return [
    m.name,
    ...(m.step.resolution === undefined ? [] : [`${String(m.step.resolution)}px`]),
    ...(m.step.durationMs === undefined ? [] : [`${String(m.step.durationMs)}ms`]),
    ...(m.step.jobMs === undefined ? [] : [`${String(m.step.jobMs)}ms`]),
  ].join(' ');
}

export function hostCheckMarkdown(rows: TypeRow[]): string {
  const lines = ['| type | status | methods | count | time ms |', '|---|---|---|---|---|'];
  for (const row of rows) {
    const methods = row.methods.length === 0 ? '-' : row.methods.map(methodCell).join(', ');
    lines.push(`| ${row.type} | ${row.status} | ${methods} | ${row.count === null ? '-' : String(row.count)} | ${row.timeMs === null ? '-' : String(row.timeMs)} |`);
  }
  const times = rows.flatMap((r) => (r.timeMs === null ? [] : [r.timeMs]));
  lines.push('', `total time ms: ${times.length === 0 ? '-' : String(times.reduce((a, b) => a + b, 0))}`);
  return `${lines.join('\n')}\n`;
}

function parseCounts(text: string | undefined, types: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of text === undefined ? [] : text.split(',')) {
    const [type, value, ...rest] = item.split('=');
    if (type === undefined || value === undefined || rest.length > 0) throw new OgwError(`--counts item must be <type>=<n>: ${item}`);
    if (!types.includes(type)) throw new OgwError(`--counts type ${type} is not in --types`);
    if (!/^[1-9][0-9]*$/.test(value)) throw new OgwError(`--counts ${type} must be an integer of 1 or more: ${value}`);
    if (counts.has(type)) throw new OgwError(`--counts has type ${type} twice`);
    counts.set(type, Number(value));
  }
  return counts;
}

export const checkCommand: CommandDef = {
  name: ['generation', 'check'],
  usage: 'ogw generation check <game> --types <type,...> [--counts <type>=<n>,...]',
  options: { types: { type: 'string' }, counts: { type: 'string' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    const typesText = str(args, 'types');
    if (typesText === undefined) throw new OgwError(`usage: ${this.usage}`);
    const types = typesText.split(',');
    const twice = types.filter((t, i) => types.indexOf(t) !== i);
    if (twice.length > 0) throw new OgwError(`--types has a type twice: ${[...new Set(twice)].join(', ')}`);
    const known = await schemaResourceTypes(ctx.env);
    const unknown = types.filter((t) => !known.includes(t));
    if (unknown.length > 0) throw new OgwError(`not a resource type of harness settings schema resourceTypes: ${unknown.join(', ')}`);
    const counts = parseCounts(str(args, 'counts'), types);
    const methods = (await ctx.settings()).resourceGeneration;
    const rows = types.map((t) => typeRow(t, methods, counts.get(t) ?? null));
    const path = join(game.root, 'records', 'setup', 'host-check.md');
    const markdown = hostCheckMarkdown(rows);
    await writeFileAtomic(path, markdown);
    return { text: markdown, data: { file: path, rows } };
  },
};
