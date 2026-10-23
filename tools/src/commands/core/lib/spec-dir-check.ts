import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exists, readJsonIfExists } from '../../../lib/fsx.ts';
import { moduleFolder, readCoreSpecDir, type CoreSpecModule } from './impl.ts';
import { filesUnder } from '../../../lib/fsx.ts';
import { serverImplementedModules, serverModuleReferences } from './server-layout.ts';
import { engineAssetRules } from './undefined.ts';
import { byteCompare } from '../../../lib/order.ts';

/** Which implementation the `core-spec/` check compares with: one engine or the server. */
export type ImplementationSide = { kind: 'engine'; engine: string } | { kind: 'server' };

export interface References {
  /** Modules referred to by module code outside DEV code. */
  code: string[];
  /** Modules referred to by DEV code. */
  dev: string[];
}

/**
 * Godot module folders `core/<module folder>/` that hold the module class `<module folder>.gd`, or `dev/<module folder>.gd`
 * for a module that is all DEV code (`client-core` Godot `## module`).
 */
async function godotImplementedFolders(projectDir: string): Promise<string[]> {
  const core = join(projectDir, 'core');
  if (!exists(core)) return [];
  const entries = await readdir(core, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && (exists(join(core, e.name, `${e.name}.gd`)) || exists(join(core, e.name, 'dev', `${e.name}.gd`))))
    .map((e) => e.name);
}

/** Client modules of `modules` with an implementation in `client/<engine>/`: their module folder holds the entry file. */
export async function engineImplementedModules(implDir: string, engine: string, modules: readonly CoreSpecModule[]): Promise<string[]> {
  const implemented = await godotImplementedFolders(join(implDir, 'client', engine));
  return modules.filter((m) => m.side === 'client' && implemented.includes(moduleFolder(m.name))).map((m) => m.name);
}

async function gdFiles(dir: string): Promise<string[]> {
  return (await filesUnder(dir, '')).filter((path) => path.endsWith('.gd'));
}

const GD_COMMENT_OR_STRING = /"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|#[^\n]*/g;

/** GDScript text without comments and string literals. */
export function gdCode(text: string): string {
  return text.replace(GD_COMMENT_OR_STRING, ' ');
}

/** GDScript text without comments; string literals stay. */
function gdWithoutComments(text: string): string {
  return text.replace(GD_COMMENT_OR_STRING, (match) => (match.startsWith('#') ? ' ' : match));
}

/** How Godot code reaches one client module: its name, the `class_name`s declared under its folder, and its folder's `res://` path. */
export interface GodotModuleNames {
  name: string;
  classNames: string[];
  folder: string;
}

/**
 * The names of each client module in the Godot project `projectDir`: the module name, every `class_name` declared in a
 * `.gd` file under `core/<module folder>/` (its `dev/` files included), and its folder `core/<module folder>/`.
 */
export async function godotModuleNames(projectDir: string, modules: readonly string[]): Promise<GodotModuleNames[]> {
  const out: GodotModuleNames[] = [];
  for (const name of modules) {
    const folder = moduleFolder(name);
    const dir = join(projectDir, 'core', folder);
    const classNames = new Set<string>();
    if (exists(dir)) {
      for (const file of await gdFiles(dir)) {
        for (const match of gdCode(await readFile(join(dir, file), 'utf8')).matchAll(/\bclass_name\s+([A-Za-z_]\w*)/g)) classNames.add(match[1] ?? '');
      }
    }
    out.push({ name, classNames: [...classNames].sort(byteCompare), folder });
  }
  return out;
}

function refersTo(code: string, withStrings: string, module: GodotModuleNames): boolean {
  if ([module.name, ...module.classNames].some((id) => new RegExp(`\\b${id}\\b`).test(code))) return true;
  return withStrings.includes(`res://core/${module.folder}/`);
}

/**
 * Other client modules that the `.gd` files of one Godot module folder refer to, outside `tests/`: by a name of
 * `godotModuleNames` in the code, or by its `res://core/<module folder>/` path in a string.
 */
export async function godotReferences(moduleDir: string, self: string, modules: readonly GodotModuleNames[]): Promise<References> {
  const code = new Set<string>();
  const dev = new Set<string>();
  for (const file of await gdFiles(moduleDir)) {
    const top = file.split('/')[0];
    if (top === 'tests') continue;
    const text = await readFile(join(moduleDir, file), 'utf8');
    const bare = gdCode(text);
    const withStrings = gdWithoutComments(text);
    for (const module of modules) {
      if (module.name !== self && refersTo(bare, withStrings, module)) (top === 'dev' ? dev : code).add(module.name);
    }
  }
  return { code: [...code].sort(byteCompare), dev: [...dev].sort(byteCompare) };
}

function referenceErrors(module: CoreSpecModule, refs: References): string[] {
  const allowed = new Set([...module.dependencies, ...module.optionalDependencies]);
  const errors = refs.code.filter((r) => !allowed.has(r)).map((r) => `${module.name} code refers to ${r}, which is not in dependencies or optionalDependencies`);
  for (const r of refs.dev) {
    if (!allowed.has(r) && !module.devDependencies.includes(r)) errors.push(`${module.name} DEV code refers to ${r}, which is not a dependency`);
  }
  return errors;
}

async function engineErrors(implDir: string, engine: string, modules: readonly CoreSpecModule[], whole: boolean): Promise<string[]> {
  if (engine !== 'godot') engineAssetRules(engine);
  const project = join(implDir, 'client', engine);
  const client = modules.filter((m) => m.side === 'client');
  const byFolder = new Map(client.map((m) => [moduleFolder(m.name), m]));
  const implemented = await godotImplementedFolders(project);
  const errors: string[] = [];
  if (whole) for (const folder of implemented) if (!byFolder.has(folder)) errors.push(`client/${engine}/core/${folder}/ has no core-spec file`);
  const names = await godotModuleNames(project, client.map((m) => m.name));
  for (const [folder, module] of byFolder) {
    if (!implemented.includes(folder)) {
      if (whole) errors.push(`${module.name} has no implementation in client/${engine}/core/${folder}/`);
      continue;
    }
    errors.push(...referenceErrors(module, await godotReferences(join(project, 'core', folder), module.name, names)));
  }
  return errors;
}

async function serverErrors(implDir: string, modules: readonly CoreSpecModule[], whole: boolean): Promise<string[]> {
  const server = modules.filter((m) => m.side === 'server');
  const implemented = new Set(await serverImplementedModules(implDir));
  const errors: string[] = [];
  const present = server.filter((m) => implemented.has(m.name));
  if (whole) {
    for (const name of [...implemented].sort(byteCompare)) if (!server.some((m) => m.name === name)) errors.push(`server module ${name} has no core-spec file`);
    for (const m of server) if (!implemented.has(m.name)) errors.push(`${m.name} has no implementation in server/core/`);
  }
  const refs = await serverModuleReferences(implDir, present.map((m) => m.name));
  for (const m of present) errors.push(...referenceErrors(m, refs.get(m.name) ?? { code: [], dev: [] }));
  return errors;
}

/** Modules on a `dependencies` cycle, one line per module where a cycle is found. */
export function cycleErrors(modules: readonly CoreSpecModule[]): string[] {
  const deps = new Map(modules.map((m) => [m.name, m.dependencies]));
  const state = new Map<string, 'visiting' | 'done'>();
  const errors: string[] = [];
  const visit = (name: string, path: string[]): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      errors.push(`dependency cycle: ${[...path.slice(path.indexOf(name)), name].join(' -> ')}`);
      return;
    }
    state.set(name, 'visiting');
    for (const dep of deps.get(name) ?? []) if (deps.has(dep)) visit(dep, [...path, name]);
    state.set(name, 'done');
  };
  for (const m of modules) visit(m.name, []);
  return errors;
}

export function adapterErrors(modules: readonly CoreSpecModule[]): string[] {
  const adapters = new Set(modules.flatMap((m) => m.adapters));
  const sources = new Set(modules.flatMap((m) => m.collectedData.map((row) => row.source)));
  const errors: string[] = [];
  for (const adapter of [...adapters].sort(byteCompare)) {
    if (!sources.has(adapter)) errors.push(`adapter ${adapter} has no collectedData row with that source`);
  }
  for (const m of modules) {
    for (const row of m.collectedData) {
      if (row.source !== 'module' && !adapters.has(row.source)) errors.push(`${m.name} collectedData source ${row.source} is neither module nor an adapter`);
    }
  }
  return errors;
}

/** Keys of a core settings schema whose property has `"x-owner": "human"`. */
export function humanKeys(schema: unknown): string[] {
  const properties = (schema as { properties?: Record<string, { 'x-owner'?: unknown }> } | null)?.properties ?? {};
  return Object.entries(properties).filter(([, value]) => value['x-owner'] === 'human').map(([key]) => key).sort(byteCompare);
}

/**
 * Settings checks over the modules with an implementation (`implemented`): their `core` settings keys are in
 * `core-settings.json`, a settings constraint key of an implemented module is there, and the `owner` `human` keys of
 * implemented modules match the `"x-owner": "human"` keys of the schema that belong to implemented modules. A key
 * belongs to the module named before its first `.`.
 */
export function settingsErrors(
  modules: readonly CoreSpecModule[],
  settings: Record<string, unknown> | null,
  schema: unknown,
  implemented: ReadonlySet<string>,
): string[] {
  const values = settings ?? {};
  const own = (key: string): boolean => implemented.has(key.slice(0, key.indexOf('.')));
  const present = modules.filter((m) => implemented.has(m.name));
  const errors: string[] = [];
  for (const m of present) {
    for (const c of m.settingsConstraints) {
      for (const key of [c.left, c.right]) if (own(key) && !(key in values)) errors.push(`${m.name} settings constraint key ${key} is not in core-settings.json`);
    }
    for (const row of m.settings) {
      if (row.source === 'core' && !(row.key in values)) errors.push(`${m.name} setting ${row.key} is not in core-settings.json`);
    }
  }
  const specHuman = present.flatMap((m) => m.settings.filter((s) => s.source === 'core' && s.owner === 'human').map((s) => s.key)).sort(byteCompare);
  const schemaHuman = humanKeys(schema).filter(own);
  for (const key of specHuman) if (!schemaHuman.includes(key)) errors.push(`${key} has owner human in the spec but no "x-owner": "human" in core-settings.schema.json`);
  for (const key of schemaHuman) if (!specHuman.includes(key)) errors.push(`${key} has "x-owner": "human" in core-settings.schema.json but not owner human in the spec`);
  return errors;
}

/** Names of the modules with an implementation: server modules in `server/core/` and client modules of every engine. */
async function implementedModules(implDir: string, modules: readonly CoreSpecModule[]): Promise<Set<string>> {
  const names = new Set(await serverImplementedModules(implDir));
  const clientDir = join(implDir, 'client');
  const engines = exists(clientDir) ? (await readdir(clientDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  for (const engine of engines) {
    const folders = new Set(await godotImplementedFolders(join(clientDir, engine)));
    for (const m of modules) if (m.side === 'client' && folders.has(moduleFolder(m.name))) names.add(m.name);
  }
  return names;
}

async function nameErrors(implDir: string): Promise<string[]> {
  const dir = join(implDir, 'core-spec');
  if (!exists(dir)) return ['core-spec/ is missing'];
  const errors: string[] = [];
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.json')).sort(byteCompare)) {
    const module = await readJsonIfExists<{ name?: unknown }>(join(dir, file));
    if (module?.name !== file.slice(0, -'.json'.length)) errors.push(`core-spec/${file}: name is ${JSON.stringify(module?.name)}`);
  }
  return errors;
}

/**
 * The `core-spec/` check of `ogw core test` (`core` command.md `## core spec file`). `whole` is true for a run
 * without modules: only that run requires the modules with an implementation to be the modules with a file.
 */
export async function specDirErrors(implDir: string, side: ImplementationSide, whole: boolean): Promise<string[]> {
  const errors = await nameErrors(implDir);
  const modules = await readCoreSpecDir(implDir);
  if (side.kind === 'engine') errors.push(...(await engineErrors(implDir, side.engine, modules, whole)));
  else errors.push(...(await serverErrors(implDir, modules, whole)));
  errors.push(...cycleErrors(modules), ...adapterErrors(modules));
  const settings = await readJsonIfExists<Record<string, unknown>>(join(implDir, 'settings', 'core-settings.json'));
  const schema = await readJsonIfExists(join(implDir, 'settings', 'core-settings.schema.json'));
  errors.push(...settingsErrors(modules, settings, schema, await implementedModules(implDir, modules)));
  return errors;
}
