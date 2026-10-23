/**
 * The Godot core project `open-game-works-core-impl/client/godot/` seen through the static group's `StaticContext`.
 * Files get the game-repo form `client/<path in the project>` so the GDScript parser, class index and type
 * resolver of `ogw check --static` read them unchanged (`res://<path>` maps to `client/<path>`).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { filesUnder } from '../../../lib/fsx.ts';
import { StaticContext, type Finding } from '../../check/static/lib/context.ts';

/** Project folders whose `.gd` files the class index reads: core code and the generated code of the core test data. */
const INDEXED = ['core', 'generated', 'dev'];

/** The Godot core project folder of `open-game-works-core-impl/`. */
export function godotProject(implDir: string): string {
  return join(implDir, 'client', 'godot');
}

/** Files of the project folders the check reads, project relative, sorted. */
export async function projectFiles(project: string): Promise<string[]> {
  const lists = await Promise.all(INDEXED.map((rel) => filesUnder(project, rel)));
  return lists.flat().sort();
}

/** `StaticContext` over the Godot core project: path `client/<p>` is the project file `<p>`. */
export class CoreStaticContext extends StaticContext {
  private readonly project: string;

  constructor(ctx: Context, project: string, files: readonly string[]) {
    super(ctx, { name: 'open-game-works-core-impl', root: project, mainRoot: project, commonDir: project, inWorktree: false }, files.map((f) => `client/${f}`));
    this.project = project;
  }

  static async open(ctx: Context, implDir: string): Promise<CoreStaticContext> {
    const project = godotProject(implDir);
    return new CoreStaticContext(ctx, project, await projectFiles(project));
  }

  override text(path: string): Promise<string> {
    return readFile(join(this.project, path.slice('client/'.length)), 'utf8');
  }

  override bytes(path: string): Promise<Buffer> {
    return readFile(join(this.project, path.slice('client/'.length)));
  }
}

/** Core code: `.gd` files under `core/` of the project (DEV code and core tests included). */
export function isCoreGd(path: string): boolean {
  return path.startsWith('client/core/') && path.endsWith('.gd');
}

/** `<module folder>` of a file inside `core/<module folder>/`, or null (for example `core/core_settings.gd`). */
export function moduleFolderOf(path: string): string | null {
  const m = /^client\/core\/([^/]+)\/./.exec(path);
  return m ? (m[1] as string) : null;
}

/** True inside `core/<module folder>/<sub>/`. */
export function inModuleSub(path: string, sub: string): boolean {
  return new RegExp(`^client/core/[^/]+/${sub}/`).test(path);
}

/** DEV code: `core/<module folder>/dev/` (`godot` `## DEV code`) and the project `dev/` folder of generated DEV code. */
export function isDevPath(path: string): boolean {
  return inModuleSub(path, 'dev') || path.startsWith('client/dev/');
}

/** Core test: `core/<module folder>/tests/` (`godot` `## test`). */
export function isTestPath(path: string): boolean {
  return inModuleSub(path, 'tests');
}

/** Adapter code: `core/<module folder>/adapters/` and fake adapters in `core/<module folder>/dev/adapters/`. */
export function isAdapterPath(path: string): boolean {
  return /^client\/core\/[^/]+\/(dev\/)?adapters\//.test(path);
}

/** A finding as a `ogw core test` preflight line: `client/godot/<path>:<line>: <reason>`. */
export function findingLine(f: Finding): string {
  const where = f.where.startsWith('client/') ? `client/godot/${f.where.slice('client/'.length)}` : f.where;
  return `${where}: ${f.message}`;
}
