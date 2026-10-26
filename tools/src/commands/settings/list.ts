import { expectPositionals, flag, str, type CommandDef, type Context } from '../../lib/command.ts';
import { HOST_KEYS } from '../../lib/settings.ts';
import { gameIssues } from './lib/game-check.ts';
import { display } from './lib/json-path.ts';
import { child, firstSentence, infoOf, propertyNames, propertyPaths, type SchemaNode } from './lib/schema-nav.ts';
import { locatePath, openTarget, parsePath, type Target } from './lib/target.ts';
import { schemaIssues } from './lib/validate.ts';

function nodesOf(schema: Record<string, unknown>): SchemaNode[] {
  return [{ node: schema, root: schema }];
}

/** Paths of the values of one `hosts` entry, as the harness settings paths that read them for this host. */
function hostKeyPaths(target: Target): string[][] {
  const entry = child(child(nodesOf(target.schema), 'hosts'), 'host');
  return propertyPaths(entry).filter((path) => (HOST_KEYS as readonly string[]).includes(path[0] as string));
}

/** Property paths of the target schema; for harness settings, also the host keys; for game settings with `coreVersion`, also `core.<core settings key>`. */
async function schemaPaths(target: Target): Promise<string[][]> {
  const paths = propertyPaths(nodesOf(target.schema));
  if (target.kind === 'harness') paths.push(...hostKeyPaths(target));
  if (target.kind !== 'game' || typeof target.value.coreVersion !== 'string') return paths;
  const core = nodesOf((await target.release()).schema);
  for (const key of propertyNames(core)) {
    paths.push(['core', key], ...propertyPaths(child(core, key), ['core', key]));
  }
  return paths;
}

/** Paths whose value is required, or required by a condition, and missing; for game settings, not the build stage values. */
async function missingPaths(ctx: Context, target: Target): Promise<string[][]> {
  const issues = target.kind === 'game' ? await gameIssues(ctx, target.game?.name ?? 'the game', target.value, false) : schemaIssues(target.schema, target.value);
  const out: string[][] = [];
  for (const issue of issues) if (issue.missing !== undefined) out.push(await parsePath(target, issue.missing));
  return out;
}

export const list: CommandDef = {
  name: ['settings', 'list'],
  usage: 'ogw settings list <harness|game <game>|core> [--owner <owner>] [--missing]',
  options: { owner: { type: 'string' }, missing: { type: 'boolean' } },
  async run(ctx, args) {
    const { target, rest } = await openTarget(ctx, args.positionals, this.usage);
    expectPositionals({ ...args, positionals: rest }, 0, 0, this.usage);
    const owner = str(args, 'owner');
    const paths = flag(args, 'missing') ? await missingPaths(ctx, target) : await schemaPaths(target);
    const rows: { path: string; description: string; xOwner: string | null }[] = [];
    for (const segments of paths) {
      const located = await locatePath(target, segments);
      if (owner !== undefined && located.owner !== owner) continue;
      rows.push({ path: display(segments), description: firstSentence(infoOf(located.nodes).description), xOwner: located.owner ?? null });
    }
    return {
      text: rows.map((row) => (row.description === '' ? row.path : `${row.path}: ${row.description}`)).join('\n'),
      data: { paths: rows },
    };
  },
};
