import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readJson, writeFileAtomic } from '../../../lib/fsx.ts';
import { installHostAddons } from '../../core/lib/godot.ts';
import type { EngineJson } from '../../core/lib/impl.ts';
import { requireEngine, toolProgram } from '../../env/api.ts';
import { parseCfg, settingName } from '../../generate/lib/godot-cfg.ts';
import {
  GDSCRIPT_ERROR_WARNINGS,
  godotTypeCheck as runGodotTypeCheck,
  runGdlint,
  type GdError,
  type GodotProject,
} from '../gdscript-checks.ts';
import type { CheckTarget } from './target.ts';

const GODOT_FOLDER = 'client/godot';

/** `.gd` files of an engine project, without `addons/` (GUT and plugins the harness tool puts there). */
export function gdFiles(target: CheckTarget, engine: string): string[] {
  const prefix = `client/${engine}/`;
  return target.files.filter((path) => path.startsWith(prefix) && path.endsWith('.gd') && !path.startsWith(`${prefix}addons/`));
}

function failure(error: GdError): string {
  return `${error.path}:${String(error.line)} ${error.message}`;
}

/** The core Godot project `client/godot/` under `root`: `res://<path>` is `client/godot/<path>`. */
function coreProject(root: string): GodotProject {
  return { root, folder: GODOT_FOLDER, repoPathOf: (res) => (res.startsWith('res://') ? `${GODOT_FOLDER}/${res.slice('res://'.length)}` : null) };
}

/**
 * `project.godot` text with the `GDSCRIPT_ERROR_WARNINGS` as errors: their own lines go, and a `[debug]` section that
 * sets each to `2` ends the file (Godot takes a repeated section's keys into the same section).
 */
export function withErrorWarnings(text: string): string {
  const names = new Set(GDSCRIPT_ERROR_WARNINGS.map((name) => `debug/gdscript/warnings/${name}`));
  const dropped = new Set<number>();
  for (const entry of parseCfg(text, 'project.godot')) {
    if (!names.has(settingName(entry))) continue;
    const count = entry.value.split('\n').length;
    for (let i = 0; i < count; i++) dropped.add(entry.line - 1 + i);
  }
  const kept = text.replace(/\r\n/g, '\n').split('\n').filter((_line, i) => !dropped.has(i)).join('\n').replace(/\n*$/, '\n');
  return `${kept}\n[debug]\n\n${GDSCRIPT_ERROR_WARNINGS.map((name) => `gdscript/warnings/${name}=2`).join('\n')}\n`;
}

/**
 * The project the Godot type check runs in, made in `folder`: the target's `client/godot/` files without `addons/` and
 * `.godot/`, GUT and the host OS plugins of `engine.json` in `addons/` as `ogw core test` puts them (`client-core`
 * Godot `## folder`), and `project.godot` with the type rule warnings as errors (`## GDScript`). The checkout is not changed.
 */
async function checkProject(ctx: Context, target: CheckTarget, engine: EngineJson, folder: string): Promise<GodotProject> {
  const prefix = `${GODOT_FOLDER}/`;
  for (const path of target.files) {
    if (!path.startsWith(prefix) || /^(addons|\.godot)\//.test(path.slice(prefix.length))) continue;
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await copyFile(join(target.root, path), join(folder, path));
  }
  const project = join(folder, GODOT_FOLDER);
  await installHostAddons(ctx, engine, project);
  const settings = join(project, 'project.godot');
  if (exists(settings)) await writeFileAtomic(settings, withErrorWarnings(await readFile(settings, 'utf8')));
  return coreProject(folder);
}

/** Godot type check (`client-core` Godot `## GDScript`) in a project made in `folder`. */
async function godotTypeCheck(ctx: Context, target: CheckTarget, folder: string): Promise<string[]> {
  const files = gdFiles(target, 'godot');
  if (files.length === 0) return [];
  const engine = await readJson<EngineJson>(join(target.root, GODOT_FOLDER, 'engine.json'));
  if (typeof engine.godot !== 'string') throw new OgwError('client/godot/engine.json has no godot version');
  const godot = await requireEngine(ctx, 'godot', engine.godot);
  const project = await checkProject(ctx, target, engine, folder);
  return (await runGodotTypeCheck(godot, project, files, ctx.env)).map(failure);
}

/** gdlint with only the name rules. */
async function godotLint(ctx: Context, target: CheckTarget): Promise<string[]> {
  const files = gdFiles(target, 'godot');
  if (files.length === 0) return [];
  const gdlint = await toolProgram(ctx, 'gdtoolkit');
  if (gdlint === null) throw new OgwError('harness settings tools.gdtoolkit is not on this host: run ogw generation install');
  return (await runGdlint(gdlint, target.root, files, ctx.env)).map(failure);
}

/** The engines whose code the engine checks check: GDScript is the language of Godot only; other engines' code is TypeScript. */
export const CHECKED_ENGINES: readonly string[] = ['godot'];

function perEngine(engines: readonly string[], godot: () => Promise<string[]>): Promise<string[]>[] {
  return engines.filter((engine) => CHECKED_ENGINES.includes(engine)).map(() => godot());
}

/** Type check of the engine code; `work` is a new folder of the code check the engine projects are made in. */
export async function engineTypeCheck(ctx: Context, target: CheckTarget, engines: readonly string[], work: string): Promise<string[]> {
  return (await Promise.all(perEngine(engines, () => godotTypeCheck(ctx, target, join(work, 'godot'))))).flat();
}

export async function engineLint(ctx: Context, target: CheckTarget, engines: readonly string[]): Promise<string[]> {
  return (await Promise.all(perEngine(engines, () => godotLint(ctx, target)))).flat();
}
