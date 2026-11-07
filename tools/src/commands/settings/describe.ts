import { expectPositionals, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { display } from './lib/json-path.ts';
import { infoOf, itemNodes, propertyKeys } from '../../lib/schema-nav.ts';
import { locatePath, openTarget, parsePath, runOf, scopeOf, type Target } from './lib/target.ts';

function allowedText(allowed: Record<string, unknown>): string {
  return Object.entries(allowed)
    .map(([keyword, value]) => {
      if (keyword === 'enum' && Array.isArray(value)) return value.map((v) => JSON.stringify(v)).join(' | ');
      if (keyword === 'const') return JSON.stringify(value);
      return `${keyword} ${typeof value === 'string' ? value : JSON.stringify(value)}`;
    })
    .join(', ');
}

/** tools/ogw.md `## settings describe`: the child keys a value of this path holds, also added to `lines`. */
function childKeys(nodes: Parameters<typeof propertyKeys>[0], lines: string[]): { properties: string[]; itemProperties: string[] } {
  const properties = propertyKeys(nodes);
  const itemProperties = propertyKeys(itemNodes(nodes));
  if (properties.length > 0) lines.push(`properties: ${properties.join(', ')}`);
  if (itemProperties.length > 0) lines.push(`item properties: ${itemProperties.join(', ')}`);
  return { properties, itemProperties };
}

/** The `x-owner`, `x-scope` and `x-run` lines of a path, also added to `lines`. */
function markLines(target: Target, segments: string[], owner: string | undefined, lines: string[]): { scope: 'local' | undefined; run: true | undefined } {
  if (owner !== undefined) lines.push(`x-owner: ${owner}`);
  const scope = scopeOf(target, segments);
  if (scope !== undefined) lines.push(`x-scope: ${scope}`);
  const run = runOf(target, segments);
  if (run !== undefined) lines.push('x-run: true');
  return { scope, run };
}

export const describe: CommandDef = {
  name: ['settings', 'describe'],
  usage: 'ogw settings describe [harness|game <game>|core] <path>',
  async run(ctx, args) {
    const { target, rest } = await openTarget(ctx, args.positionals, this.usage, { harnessWithout: true });
    expectPositionals({ ...args, positionals: rest }, 1, 1, this.usage);
    const segments = await parsePath(target, rest[0] as string);
    const path = display(segments);
    const { nodes, owner } = await locatePath(target, segments);
    if (nodes.length === 0) throw new OgwError(`not a settings path: ${path}`);
    const info = infoOf(nodes);
    const lines = [`path: ${path}`];
    if (info.description !== undefined) lines.push(`description: ${info.description}`);
    if (info.type !== undefined) lines.push(`type: ${Array.isArray(info.type) ? info.type.join(' | ') : JSON.stringify(info.type).replaceAll('"', '')}`);
    if (Object.keys(info.allowed).length > 0) lines.push(`allowed: ${allowedText(info.allowed)}`);
    if (info.default !== undefined) lines.push(`default: ${JSON.stringify(info.default)}`);
    const { properties, itemProperties } = childKeys(nodes, lines);
    const { scope, run } = markLines(target, segments, owner, lines);
    return {
      text: lines.join('\n'),
      data: {
        path,
        description: info.description ?? null,
        type: info.type ?? null,
        allowed: info.allowed,
        default: info.default ?? null,
        properties,
        itemProperties,
        xOwner: owner ?? null,
        xScope: scope ?? null,
        xRun: run ?? null,
      },
    };
  },
};
