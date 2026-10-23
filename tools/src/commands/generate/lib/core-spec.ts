import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { readJson } from '../../../lib/fsx.ts';
import { harnessRoot } from '../../../lib/paths.ts';
import type { GameSettings } from '../../../lib/settings.ts';

/** One `settings` row of a `core-spec.json` module (`core` skill `command.md` `## core spec file`). */
export interface SpecSetting {
  key: string;
  type: string;
  source: string;
  owner: string;
}

/** One `operations` item of a `core-spec.json` module. */
export interface SpecOperation {
  name: string;
  inputs: ('translationKey' | 'other')[];
}

/** The fields of a `core-spec.json` module that the harness tool reads. */
export interface SpecModule {
  name: string;
  side: 'client' | 'server';
  lifecycle: boolean;
  dependencies: string[];
  optionalDependencies: string[];
  devDependencies: string[];
  settings: SpecSetting[];
  tables: { name: string }[];
  operations: SpecOperation[];
}

export interface CoreSpec {
  version: string;
  modules: SpecModule[];
}

/** Modules every game uses (`core` skill `## module`). */
export const ALWAYS_MODULES: readonly string[] = ['BootstrapCore', 'routing', 'migration', 'user-snapshot-clone'];

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOperation(value: unknown): value is SpecOperation {
  const op = value as Partial<SpecOperation> | null;
  return (
    typeof op === 'object' &&
    op !== null &&
    typeof op.name === 'string' &&
    Array.isArray(op.inputs) &&
    (op.inputs as unknown[]).every((kind) => kind === 'translationKey' || kind === 'other')
  );
}

function checkModule(value: unknown, path: string): SpecModule {
  const m = value as Partial<SpecModule> | null;
  const ok =
    typeof m === 'object' &&
    m !== null &&
    typeof m.name === 'string' &&
    (m.side === 'client' || m.side === 'server') &&
    typeof m.lifecycle === 'boolean' &&
    isStringList(m.dependencies) &&
    isStringList(m.optionalDependencies) &&
    isStringList(m.devDependencies) &&
    Array.isArray(m.settings) &&
    Array.isArray(m.tables) &&
    Array.isArray(m.operations) &&
    m.operations.every(isOperation);
  if (!ok) throw new OgwError(`invalid module in ${path}: ${JSON.stringify(value)}`);
  return m as SpecModule;
}

export function parseCoreSpec(value: unknown, path: string): CoreSpec {
  const spec = value as { version?: unknown; modules?: unknown } | null;
  if (typeof spec !== 'object' || spec === null || typeof spec.version !== 'string' || !Array.isArray(spec.modules)) {
    throw new OgwError(`invalid core spec file: ${path}`);
  }
  return { version: spec.version, modules: spec.modules.map((m) => checkModule(m, path)) };
}

/** Reads `core-spec.json` of a release folder. */
export async function readCoreSpec(releaseDir: string): Promise<CoreSpec> {
  const path = join(releaseDir, 'core-spec.json');
  return parseCoreSpec(await readJson(path), path);
}

/** `names` and their closure over `dependencies`, and over `devDependencies` too when `dev` is true, sorted by name. */
function closure(spec: CoreSpec, names: readonly string[], dev: boolean): SpecModule[] {
  const byName = new Map(spec.modules.map((m) => [m.name, m]));
  const seen = new Map<string, SpecModule>();
  const queue = [...names];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (seen.has(name)) continue;
    const module = byName.get(name);
    if (!module) throw new OgwError(`core module ${name} is not in core version ${spec.version}`);
    seen.set(name, module);
    queue.push(...module.dependencies);
    if (dev) queue.push(...module.devDependencies);
  }
  return [...seen.values()].sort((a, b) => compareBytes(a.name, b.name));
}

/**
 * The modules a game uses: `ALWAYS_MODULES`, game settings `coreModules`, and their closure over
 * `dependencies` (which holds the `server dependency:` modules and no DEV-only module).
 */
export function usedModules(spec: CoreSpec, settings: GameSettings): SpecModule[] {
  return closure(spec, [...ALWAYS_MODULES, ...(settings.coreModules?.client ?? []), ...(settings.coreModules?.server ?? [])], false);
}

/**
 * The modules of a run with DEV code (`core` skill `## module`): the used modules and their DEV modules, the closure of
 * the used modules over `dependencies` and `devDependencies`, sorted by name.
 */
export function devCodeModules(spec: CoreSpec, used: readonly SpecModule[]): SpecModule[] {
  return closure(spec, used.map((m) => m.name), true);
}

export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Module names in the order of the `## module` table of the harness `skills/client-core/SKILL.md`. */
export async function clientModuleTableOrder(env: NodeJS.ProcessEnv): Promise<string[]> {
  const text = await readFile(join(harnessRoot(env), 'skills', 'client-core', 'SKILL.md'), 'utf8');
  const section = /^## module\n([\s\S]*?)(?=^## )/m.exec(text)?.[1] ?? '';
  const names: string[] = [];
  for (const line of section.split('\n')) {
    const name = /^\| `([A-Za-z]+)` \|/.exec(line)?.[1];
    if (name) names.push(name);
  }
  return names;
}

/**
 * Client modules with a lifecycle that the generated module list leaves out: the DEV entry adds `QACore`,
 * and `UnitTestCore` is never in it (`bootstrap-core` spec, Godot rules).
 */
const NOT_IN_MODULE_LIST: ReadonlySet<string> = new Set(['QACore', 'UnitTestCore']);

/**
 * The generated `BootstrapCore` module list: the game's client modules whose `lifecycle` is true, dependencies
 * first, and among candidates for the same place the one earlier in the client-core module table.
 */
export function moduleListOrder(modules: readonly SpecModule[], tableOrder: readonly string[]): string[] {
  const listed = modules.filter((m) => m.side === 'client' && m.lifecycle && !NOT_IN_MODULE_LIST.has(m.name));
  const rank = (name: string): number => {
    const index = tableOrder.indexOf(name);
    if (index === -1) throw new OgwError(`client module ${name} is not in the client-core module table`);
    return index;
  };
  const names = new Set(listed.map((m) => m.name));
  const pending = new Map(listed.map((m) => [m.name, m.dependencies.filter((d) => names.has(d))]));
  const order: string[] = [];
  while (pending.size > 0) {
    const ready = [...pending].filter(([, deps]) => deps.every((d) => order.includes(d))).map(([name]) => name);
    if (ready.length === 0) throw new OgwError(`dependency cycle among client modules: ${[...pending.keys()].join(', ')}`);
    ready.sort((a, b) => rank(a) - rank(b));
    const next = ready[0] as string;
    order.push(next);
    pending.delete(next);
  }
  return order;
}
