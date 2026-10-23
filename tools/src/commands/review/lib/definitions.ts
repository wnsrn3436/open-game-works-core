import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readText } from '../../../lib/fsx.ts';
import { revParse } from '../../../lib/git.ts';
import { markdownSection, tableCells } from '../../agent/lib/prompt.ts';
import { coreSpecDependencies } from '../../agent/lib/order.ts';
import { buildCoreSpec } from '../../core/spec-api.ts';

export interface ModuleSpec {
  module: string;
  side: 'client' | 'server';
  /** Absolute path of the spec file. */
  spec: string;
}

/** Modules of the `## module` tables of `skills/client-core/SKILL.md` and `skills/server-core/SKILL.md`. */
export async function moduleSpecs(harness: string): Promise<ModuleSpec[]> {
  const specs: ModuleSpec[] = [];
  for (const side of ['client', 'server'] as const) {
    const skill = join(harness, 'skills', `${side}-core`, 'SKILL.md');
    const section = markdownSection(await readText(skill), 'module') ?? '';
    for (const line of section.split('\n')) {
      if (!line.startsWith('| `')) continue;
      const cells = tableCells(line);
      const module = /^`([^`]+)`$/.exec(cells[0] ?? '')?.[1];
      const link = /\]\(([^)#]+)/.exec(cells[1] ?? '')?.[1];
      if (module !== undefined && link !== undefined) specs.push({ module, side, spec: resolve(harness, 'skills', `${side}-core`, link) });
    }
  }
  return specs;
}

async function engines(coreImpl: string): Promise<string[]> {
  const client = join(coreImpl, 'client');
  const entries = await readdir(client, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && exists(join(client, e.name, 'engine.json'))).map((e) => e.name).sort();
}

/**
 * The dependencies of a module: from `core-spec/` on main of `open-game-works-core-impl/`, the specs the code there was made
 * from, or from the module specs of the harness working tree (`spec`), which a spec review checks before `core-spec/`
 * is written from them.
 */
async function moduleDependencies(ctx: Context, target: string, from: 'main' | 'spec'): Promise<string[]> {
  if (from === 'spec') {
    const module = (await buildCoreSpec(ctx)).modules.get(target) as { dependencies?: unknown } | undefined;
    return Array.isArray(module?.dependencies) ? module.dependencies.filter((d): d is string => typeof d === 'string') : [];
  }
  const coreImpl = (await ctx.workspace()).coreImpl;
  const main = await revParse(coreImpl, 'main', { env: ctx.env });
  return main === null ? [] : (await coreSpecDependencies(coreImpl, main)).get(target) ?? [];
}

/**
 * Definition documents of a core target: a module, `contract-tool` or `data-tool`. `dependencies`: where the module's
 * dependencies are read (`moduleDependencies`).
 */
export async function coreDefinitions(ctx: Context, target: string, dependencies: 'main' | 'spec' = 'main'): Promise<string[]> {
  const ws = await ctx.workspace();
  const skill = (path: string): string => join(ws.harness, 'skills', path);
  if (target === 'contract-tool') return [skill('contract/SKILL.md'), skill('contract/tool.md')];
  if (target === 'data-tool') return [skill('data/SKILL.md'), skill('data/tool.md')];
  const specs = await moduleSpecs(ws.harness);
  const spec = specs.find((s) => s.module === target);
  if (!spec) throw new OgwError(`unknown core review target: ${target}`);
  const depSpecs = (await moduleDependencies(ctx, target, dependencies)).map((dep) => specs.find((s) => s.module === dep)?.spec).filter((p): p is string => p !== undefined);
  const paths = [spec.spec, ...depSpecs, skill('core/SKILL.md'), skill('core/command.md')];
  if (spec.side === 'server') paths.push(skill('server-core/SKILL.md'));
  else {
    paths.push(skill('client-core/SKILL.md'));
    for (const engine of await engines(ws.coreImpl)) paths.push(skill(`client-core/engines/${engine}.md`));
  }
  return [...new Set(paths)];
}

/** The usage of `ogw review next tool`, a part of the usage of `ogw review next`. */
export const NEXT_TOOL_USAGE = 'ogw review next tool <target> --definition <file>... [--since <commit>|--debt] [--restart|--respec|--continue|--reopen]';

/** Definition documents of a `ogw` command target: the `--definition` files, which a tool target needs. */
export function toolDefinitions(ctx: Context, target: string, given: readonly string[]): string[] {
  if (given.length === 0) throw new OgwError(`give the documents that define ${target} with --definition\nusage: ${NEXT_TOOL_USAGE}`);
  const paths = given.map((path) => resolve(ctx.cwd, path));
  const missing = paths.filter((path) => !exists(path));
  if (missing.length > 0) throw new OgwError(`definition file not found: ${missing.join(', ')}`);
  return paths;
}
