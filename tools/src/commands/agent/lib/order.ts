import { OgwError } from '../../../lib/errors.ts';
import { git, showFile } from '../../../lib/git.ts';
import { byteCompare } from '../../../lib/order.ts';
import { TOOLS } from '../../core/lib/tools.ts';

/**
 * `dependencies` of every module in `core-spec/` at a commit of `open-game-works-core-impl/`, or of the `core-spec/` files in
 * `paths` only. With `skipInvalid`, a file that is not JSON or has no name is left out instead of failing.
 */
export async function coreSpecDependencies(
  coreImpl: string,
  commit: string,
  options: { skipInvalid?: boolean; paths?: readonly string[] } = {},
): Promise<Map<string, string[]>> {
  const listed = options.paths ?? (await git(coreImpl, ['ls-tree', '--name-only', commit, 'core-spec/'])).split('\n');
  const modules = new Map<string, string[]>();
  for (const path of listed.filter((p) => p.startsWith('core-spec/') && p.endsWith('.json'))) {
    const bytes = await showFile(coreImpl, commit, path);
    if (bytes === null) continue;
    let spec: { name?: unknown; dependencies?: unknown };
    try {
      spec = JSON.parse(bytes.toString('utf8')) as { name?: unknown; dependencies?: unknown };
    } catch {
      if (options.skipInvalid === true) continue;
      throw new OgwError(`invalid JSON in ${path} at ${commit}`);
    }
    if (typeof spec.name !== 'string') {
      if (options.skipInvalid === true) continue;
      throw new OgwError(`${path} has no name`);
    }
    const deps = Array.isArray(spec.dependencies) ? spec.dependencies.filter((d): d is string => typeof d === 'string') : [];
    modules.set(spec.name, deps);
  }
  return modules;
}

/**
 * Topological order: modules a module depends on come first; modules of the same step are in byte order of
 * their names. The step of a module is one more than the highest step of its dependencies. A module on a dependency
 * cycle, or depending on one, has no step and is left out of the order.
 */
export function topologicalOrder(dependencies: ReadonlyMap<string, readonly string[]>): string[] {
  const step = new Map<string, number | null>();
  const visiting = new Set<string>();
  const stepOf = (name: string): number | null => {
    const known = step.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) return null;
    visiting.add(name);
    const deps = (dependencies.get(name) ?? []).filter((dep) => dependencies.has(dep)).map(stepOf);
    visiting.delete(name);
    const value = deps.some((dep) => dep === null) ? null : deps.length === 0 ? 0 : Math.max(...(deps as number[])) + 1;
    step.set(name, value);
    return value;
  };
  const names = [...dependencies.keys()];
  for (const name of names) stepOf(name);
  return names
    .filter((name) => step.get(name) !== null)
    .sort((a, b) => (step.get(a) as number) - (step.get(b) as number) || byteCompare(a, b));
}

export interface MergeCandidate {
  id: string;
  /** `--module` values of a core agent job; empty for other jobs. */
  modules: string[];
}

/**
 * Merge order: core agent jobs started with `--module` by the position of their last module in the
 * topological order, then the other ids in the given order. A tool (`contract-tool`, `data-tool`) comes
 * before every module, since module data checks go into the data tool. A job with a module that is not in the
 * order is left out of `ids` and put in `unordered` with that module.
 */
export function mergeOrder(
  candidates: readonly MergeCandidate[],
  order: readonly string[],
): { ids: string[]; unordered: { id: string; module: string }[] } {
  const position = new Map(order.map((name, i) => [name, i]));
  const unordered: { id: string; module: string }[] = [];
  const keyed: { id: string; at: number; i: number }[] = [];
  candidates.forEach((candidate, i) => {
    if (candidate.modules.length === 0) return;
    const at = candidate.modules.map((module) => ((TOOLS as readonly string[]).includes(module) ? -1 : position.get(module)));
    const missing = candidate.modules.find((_, j) => at[j] === undefined);
    if (missing !== undefined) unordered.push({ id: candidate.id, module: missing });
    else keyed.push({ id: candidate.id, at: Math.max(...(at as number[])), i });
  });
  keyed.sort((a, b) => a.at - b.at || a.i - b.i);
  return { ids: [...keyed.map((entry) => entry.id), ...candidates.filter((c) => c.modules.length === 0).map((c) => c.id)], unordered };
}
