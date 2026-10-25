import { join } from 'node:path';
import { expectPositionals, positional, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { writeFileAtomic } from '../../lib/fsx.ts';
import type { GenerationMethod, MeasuredStep } from '../../lib/settings.ts';
import { loadSchema, schemaPath, type HarnessSettings } from '../../lib/settings.ts';
import type { Context } from '../../lib/command.ts';
import { exists } from '../../lib/fsx.ts';
import { providerCliChecks } from '../env/lib/hostcheck.ts';
import { LIST_PATH, readList } from '../resource/lib/list.ts';
import { emptySpec } from '../resource/lib/spec.ts';
import { gameImageMethod, IMAGE_METHOD, IMAGE_TYPES, methodChoices } from './lib/select.ts';

export type TypeStatus = 'ok' | 'unmeasured' | 'missing';

export interface TypeRow {
  type: string;
  status: TypeStatus;
  methods: { name: string; step: MeasuredStep }[];
  count: number | null;
  timeMs: number | null;
  /** The methods that will make the type and their billing, as `ogw generation methods` gives them (`ok` types). */
  use: string[];
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

/**
 * `game-setup` 6: status of a type and its methods with an `ok` step. With `makers` (an image type: the methods
 * `ogw generation methods` gives it), the status and the duration come only from the methods of the type named there.
 */
export function typeRow(type: string, methods: readonly GenerationMethod[], count: number | null, makers?: readonly string[]): TypeRow {
  const own = methods.filter((m) => m.resourceTypes.includes(type));
  const withOk = own.flatMap((m) => {
    const step = lastOk(m);
    return step ? [{ name: m.name, step }] : [];
  });
  const counted = makers === undefined ? own : own.filter((m) => makers.includes(m.name));
  const countedOk = withOk.filter((m) => counted.some((c) => c.name === m.name));
  const status: TypeStatus = countedOk.length > 0 ? 'ok' : counted.some((m) => m.measured === undefined) ? 'unmeasured' : 'missing';
  const timeMs = status === 'ok' && count !== null ? Math.min(...countedOk.map((m) => count * (m.step.jobMs ?? 0))) : null;
  return { type, status, methods: withOk, count: status === 'ok' ? count : null, timeMs, use: [] };
}

/** The methods that can make a key of an image type in a game (`production.md` `## method`): its image method and the temporary method. */
export function imageTypeMakers(imageMethod: string): string[] {
  return [...new Set([imageMethod, IMAGE_METHOD])];
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
  const lines = ['| type | status | methods | to use | count | time ms |', '|---|---|---|---|---|---|'];
  for (const row of rows) {
    const methods = row.methods.length === 0 ? '-' : row.methods.map(methodCell).join(', ');
    const use = row.use.length === 0 ? '-' : row.use.join(', ');
    lines.push(`| ${row.type} | ${row.status} | ${methods} | ${use} | ${row.count === null ? '-' : String(row.count)} | ${row.timeMs === null ? '-' : String(row.timeMs)} |`);
  }
  const times = rows.flatMap((r) => (r.timeMs === null ? [] : [r.timeMs]));
  lines.push('', `total time ms: ${times.length === 0 ? '-' : String(times.reduce((a, b) => a + b, 0))}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Fills `use` of the `ok` rows: each method `ogw generation methods` would give a key of that type in this game, with
 * `temporary` for the temporary method, and its billing (`game-setup` 6).
 */
async function addUse(ctx: Context, settings: HarnessSettings, imageMethod: string, rows: TypeRow[]): Promise<void> {
  const ok = rows.filter((r) => r.status === 'ok');
  if (ok.length === 0) return;
  const billing = new Map((await providerCliChecks(ctx, settings)).map((p) => [p.provider, p.billing ?? 'unknown']));
  for (const row of ok) {
    const choices = await methodChoices(ctx, settings, row.type, emptySpec(), imageMethod);
    row.use = choices.map((c) => {
      const provider = settings.resourceGeneration.find((m) => m.name === c.name)?.provider;
      return `${c.name}${c.temporary ? ' temporary' : ''} (${provider === undefined ? 'none' : (billing.get(provider) ?? 'unknown')})`;
    });
  }
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
    const settings = await ctx.settings();
    const list = exists(join(game.root, LIST_PATH)) ? await readList(game.root) : [];
    const imageMethod = gameImageMethod(settings, list);
    const rows = types.map((t) => typeRow(t, settings.resourceGeneration, counts.get(t) ?? null, IMAGE_TYPES.includes(t) ? imageTypeMakers(imageMethod) : undefined));
    await addUse(ctx, settings, imageMethod, rows);
    const path = join(game.root, 'records', 'setup', 'host-check.md');
    const markdown = hostCheckMarkdown(rows);
    await writeFileAtomic(path, markdown);
    return { text: markdown, data: { file: path, rows } };
  },
};
