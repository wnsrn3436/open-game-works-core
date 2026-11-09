import { OgwError } from '../../lib/errors.ts';
import { git } from '../../lib/git.ts';
import { str, type CommandDef, type Context } from '../../lib/command.ts';
import { coreImplOf, moduleFolder, readCoreSpecDir, type CoreSpecModule } from './lib/impl.ts';
import { TOOLS } from './lib/tools.ts';
import { byteCompare } from '../../lib/order.ts';

/** The given modules and every module that depends on one of them directly or indirectly. */
export function dependentsOf(modules: ReadonlyMap<string, CoreSpecModule>, given: readonly string[]): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const module of modules.values()) {
    for (const dep of [...module.dependencies, ...module.optionalDependencies, ...module.devDependencies]) {
      const users = reverse.get(dep) ?? [];
      users.push(module.name);
      reverse.set(dep, users);
    }
  }
  const found = new Set(given);
  const queue = [...given];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    for (const user of reverse.get(name) ?? []) {
      if (found.has(user)) continue;
      found.add(user);
      queue.push(user);
    }
  }
  return found;
}

export const dependents: CommandDef = {
  name: ['core', 'dependents'],
  usage: 'ogw core dependents <module>...',
  async run(ctx, args) {
    if (args.positionals.length === 0) throw new OgwError(`usage: ${this.usage}`);
    const modules = new Map((await readCoreSpecDir(await coreImplOf(ctx), { required: true })).map((m) => [m.name, m]));
    const unknown = args.positionals.filter((name) => !modules.has(name));
    if (unknown.length > 0) {
      return { exitCode: 1, text: `not in core-spec: ${unknown.join(' ')}`, data: { unknown } };
    }
    const found = [...dependentsOf(modules, args.positionals)].sort(byteCompare);
    const server = found.filter((name) => modules.get(name)?.side === 'server');
    const client = found.filter((name) => modules.get(name)?.side === 'client');
    return { text: `server: ${server.join(' ')}\nclient: ${client.join(' ')}`, data: { server, client } };
  },
};

/**
 * The module or tool a file of `open-game-works-core-impl/` belongs to (`server-core` and `client-core` `## folder`): the
 * module of `core-spec/<module>.json`, `server/core/<module>/` or `client/<engine>/core/<module folder>/`, or the tool of
 * `tools/<tool>/`.
 */
function changedPart(path: string, folders: ReadonlyMap<string, string>): { module: string } | { tool: string } | null {
  const spec = /^core-spec\/([^/]+)\.json$/.exec(path);
  if (spec) return { module: spec[1] as string };
  const server = /^server\/core\/([^/]+)\/./.exec(path);
  if (server) return { module: server[1] as string };
  const client = /^client\/[^/]+\/core\/([^/]+)\/./.exec(path);
  if (client) {
    const module = folders.get(client[1] as string);
    return module === undefined ? null : { module };
  }
  const tool = /^tools\/([^/]+)\//.exec(path);
  if (tool && (TOOLS as readonly string[]).includes(tool[1] as string)) return { tool: tool[1] as string };
  return null;
}

/**
 * The review targets of an `update core` from a commit: each module and tool with a changed file. A module without a
 * changed file is not a target, even when a module it depends on changed.
 */
export function reviewTargets(modules: ReadonlyMap<string, CoreSpecModule>, changed: readonly string[]): { modules: Set<string>; tools: Set<string> } {
  const folders = new Map([...modules.keys()].map((name) => [moduleFolder(name), name]));
  const found = new Set<string>();
  const tools = new Set<string>();
  for (const path of changed) {
    const part = changedPart(path, folders);
    if (part === null) continue;
    if ('tool' in part) tools.add(part.tool);
    else if (modules.has(part.module)) found.add(part.module);
  }
  return { modules: found, tools };
}

/** `reviewTargets` of the files of `open-game-works-core-impl/` that changed from `since` to `until`. */
export async function reviewTargetsSince(ctx: Context, impl: string, modules: ReadonlyMap<string, CoreSpecModule>, since: string, until: string): Promise<{ modules: Set<string>; tools: Set<string> }> {
  // without rename detection: a moved file gives its old path as well as its new one
  const changed = (await git(impl, ['diff', '--name-only', '--no-renames', `${since}..${until}`], { env: ctx.env })).split('\n').filter((line) => line !== '');
  return reviewTargets(modules, changed);
}

export const reviewTargetsCommand: CommandDef = {
  name: ['core', 'review-targets'],
  usage: 'ogw core review-targets --since <commit>',
  options: { since: { type: 'string' } },
  async run(ctx, args) {
    const since = str(args, 'since');
    if (since === undefined || args.positionals.length > 0) throw new OgwError(`usage: ${this.usage}`);
    const impl = await coreImplOf(ctx);
    const modules = new Map((await readCoreSpecDir(impl, { required: true })).map((m) => [m.name, m]));
    const found = await reviewTargetsSince(ctx, impl, modules, since, 'main');
    const sorted = [...found.modules].sort(byteCompare);
    const server = sorted.filter((name) => modules.get(name)?.side === 'server');
    const client = sorted.filter((name) => modules.get(name)?.side === 'client');
    const tools = [...found.tools].sort(byteCompare);
    return { text: `server: ${server.join(' ')}\nclient: ${client.join(' ')}\ntools: ${tools.join(' ')}`, data: { server, client, tools } };
  },
};
