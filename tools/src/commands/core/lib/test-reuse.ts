/**
 * Passing module results of `ogw core test` kept with a key, which a later run of the same key uses instead of running
 * the module again (`core` command.md `## command`). They live in the harness git common dir.
 */
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonIfExists, writeJsonAtomic } from '../../../lib/fsx.ts';
import { commonDir, git, gitRaw, statusLines } from '../../../lib/git.ts';
import { harnessRoot } from '../../../lib/paths.ts';
import { moduleFolder, type CoreSpecModule } from './impl.ts';

/** The target of a run: as `ogw core test` takes it. */
export type ReuseTarget = { kind: 'engine'; engine: string; web: boolean } | { kind: 'server' } | { kind: 'tools' };

/** A kept passing result: the counts the run log summary and the output take. */
export interface KeptResult {
  tests: number;
  passed: number;
}

/** The module whose folder, with the folders of its dependencies, every module test of the side runs with. */
const TEST_MODULE: Readonly<Record<'server' | 'client', string>> = { server: 'testing', client: 'UnitTestCore' };

/** The folder of a module of the target, or null for a module of the other side. */
function folderOf(target: ReuseTarget, module: CoreSpecModule): string | null {
  if (target.kind === 'server') return module.side === 'server' ? `server/core/${module.name}` : null;
  if (target.kind === 'engine') return module.side === 'client' ? `client/${target.engine}/core/${moduleFolder(module.name)}` : null;
  return null;
}

/** The modules reached from `start` through `dependencies`, `devDependencies` and `optionalDependencies`, `start` included. */
function reached(all: readonly CoreSpecModule[], start: readonly string[]): CoreSpecModule[] {
  const byName = new Map(all.map((m) => [m.name, m]));
  const seen = new Set<string>();
  const queue = [...start];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    const module = byName.get(name);
    if (seen.has(name) || module === undefined) continue;
    seen.add(name);
    queue.push(...module.dependencies, ...module.devDependencies, ...module.optionalDependencies);
  }
  return [...seen].map((name) => byName.get(name) as CoreSpecModule);
}

/**
 * The checkout paths a module's test depends on, besides the harness `tools/`: `[folders, package folders, module
 * folders]`. A package folder counts with every entry of it, and every entry of its `core/` except the module folders of
 * the side (`moduleFolders`): files such as `server/core/start.ts` or `client/<engine>/core/core_settings.gd` that the
 * module tests run are in no module folder. Besides the folders `core` command.md names, the run reads
 * `fixtures/`, `proto/` and `settings/` (the core test data build, the fixture folder of the tests), and the server and
 * engine targets build the core test data with `tools/contract-tool/` and `tools/data-tool/`; the round trip of a tool
 * test compiles every engine's whole `client/<engine>/`.
 */
export function keyPaths(target: ReuseTarget, module: string, all: readonly CoreSpecModule[]): { folders: string[]; packages: string[]; moduleFolders: string[] } {
  const folders = ['core-spec', 'test-data', 'fixtures', 'proto', 'settings'];
  if (target.kind === 'tools') return { folders: [...folders, 'tools', 'client'], packages: [], moduleFolders: [] };
  const side = target.kind === 'server' ? 'server' : 'client';
  for (const each of reached(all, [module, TEST_MODULE[side]])) {
    const folder = folderOf(target, each);
    if (folder !== null) folders.push(folder);
  }
  folders.push('tools/contract-tool', 'tools/data-tool');
  const moduleFolders = all.map((each) => folderOf(target, each)).filter((folder): folder is string => folder !== null);
  return { folders: [...new Set(folders)].sort(), packages: [target.kind === 'server' ? 'server' : `client/${target.engine}`], moduleFolders };
}

/**
 * The tree of the harness `tools/` at HEAD, or null when it has changes not committed or cannot be read: then HEAD's
 * tree is not the code that runs, and no result keyed by it is kept or used.
 */
export async function harnessToolsTree(env: NodeJS.ProcessEnv): Promise<string | null> {
  const harness = harnessRoot(env);
  if ((await statusLines(harness, { env }, ['tools']).catch(() => ['unreadable'])).length > 0) return null;
  const tree = await gitRaw(harness, ['rev-parse', 'HEAD:tools'], { env });
  return tree.code === 0 ? tree.stdout.trim() : null;
}

/** `git ls-tree` lines of `paths` at `commit`; a missing path has none. */
async function treeLines(implDir: string, commit: string, paths: readonly string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  if (paths.length === 0) return [];
  return (await git(implDir, ['ls-tree', '-z', '--full-tree', commit, '--', ...paths], { env })).split('\0').filter((line) => line !== '');
}

/**
 * The key of each module of a run at `commit`, the clean checkout's HEAD the tests start on; `name` is the target's
 * record name, which tells `--web` apart; `settingsTools` is harness settings `tools`, the pinned programs and images
 * the run uses (PostgreSQL, Chromium). Null when the harness `tools/` has changes not committed: the code that runs
 * is not its tree.
 */
export async function moduleKeys(
  implDir: string,
  commit: string,
  target: ReuseTarget,
  name: string,
  modules: readonly string[],
  all: readonly CoreSpecModule[],
  env: NodeJS.ProcessEnv,
  settingsTools: unknown,
): Promise<Map<string, string> | null> {
  const tools = await harnessToolsTree(env);
  if (tools === null) return null;
  const keys = new Map<string, string>();
  for (const module of modules) {
    const { folders, packages, moduleFolders } = keyPaths(target, module, all);
    const own = await treeLines(implDir, commit, folders, env);
    const inPackages = (await treeLines(implDir, commit, packages.map((p) => `${p}/`), env)).filter((line) => !packages.some((p) => line.endsWith(`\t${p}/core`)));
    const skipped = new Set(moduleFolders);
    const inCore = (await treeLines(implDir, commit, packages.map((p) => `${p}/core/`), env)).filter((line) => !skipped.has(line.slice(line.indexOf('\t') + 1)));
    const text = JSON.stringify({ target: name, module, trees: [...own, ...inPackages, ...inCore].sort(), harnessTools: tools, settingsTools });
    keys.set(module, createHash('sha256').update(text).digest('hex'));
  }
  return keys;
}

async function resultsFolder(env: NodeJS.ProcessEnv): Promise<string> {
  return join(await commonDir(harnessRoot(env), { env }), 'ogw-cache', 'core-test-results');
}

/** The passing result kept with `key`, or null. */
export async function keptResult(env: NodeJS.ProcessEnv, key: string): Promise<KeptResult | null> {
  const kept = await readJsonIfExists<Partial<KeptResult>>(join(await resultsFolder(env), `${key}.json`)).catch(() => null);
  return typeof kept?.tests === 'number' && typeof kept.passed === 'number' && kept.tests > 0 && kept.passed === kept.tests ? { tests: kept.tests, passed: kept.passed } : null;
}

/** Keeps a passing result of a module with its key. */
export async function keepResult(env: NodeJS.ProcessEnv, key: string, result: KeptResult & { target: string; module: string; commit: string }): Promise<void> {
  const folder = await resultsFolder(env);
  await mkdir(folder, { recursive: true });
  await writeJsonAtomic(join(folder, `${key}.json`), { ...result, keptAt: Date.now() });
}
