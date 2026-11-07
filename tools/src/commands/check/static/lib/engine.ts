import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OgwError } from '../../../../lib/errors.ts';
import { whenNotFound } from '../../../../lib/fsx.ts';
import { LIMITS } from '../../../../lib/limits.ts';
import { run } from '../../../../lib/proc.ts';
import { coreReleaseOfGame, extractedAsset } from '../../../core/api.ts';
import { requireEngine } from '../../../env/api.ts';
import type { StaticContext } from './context.ts';
import { newPrivateTempFolder } from '../../../../lib/secret-files.ts';

const engines = new WeakMap<StaticContext, Promise<string>>();

/** Engine of the game; the static checks of this file are defined for Godot only. */
export async function gameEngine(sc: StaticContext): Promise<string> {
  const engine = (await sc.settings()).engine;
  if (typeof engine !== 'string') throw new OgwError('game settings `engine` is missing');
  return engine;
}

/** Godot executable of the version in the game's core release `engine.json`; fails when it is not installed. */
export function godotExecutable(sc: StaticContext): Promise<string> {
  let value = engines.get(sc);
  if (!value) {
    value = (async () => {
      const release = await coreReleaseOfGame(sc.ctx, sc.game);
      const dir = await extractedAsset(sc.ctx, release, 'client-godot.zip');
      const info = JSON.parse(await readFile(join(dir, 'engine.json'), 'utf8')) as { godot?: unknown };
      if (typeof info.godot !== 'string') throw new OgwError('engine.json of the core release has no `godot` version');
      return requireEngine(sc.ctx, 'godot', info.godot);
    })();
    engines.set(sc, value);
  }
  return value;
}

const KEY_SCRIPT = `extends SceneTree

func _init() -> void:
\tvar out: Array[bool] = []
\tfor n: String in OS.get_cmdline_user_args():
\t\tout.append(OS.find_keycode_from_string(n) != KEY_NONE)
\tprint("OGW_KEYS " + JSON.stringify(out))
\tquit()
`;

/** Which names Godot reads as keys (`OS.find_keycode_from_string()` is not `KEY_NONE`). */
export async function godotKeyNames(sc: StaticContext, names: readonly string[]): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (names.length === 0) return result;
  const godot = await godotExecutable(sc);
  const dir = await newPrivateTempFolder('ogw-keys-', sc.ctx.env);
  try {
    const script = join(dir, 'keys.gd');
    await writeFile(script, KEY_SCRIPT);
    const out = await run(godot, ['--headless', '--script', script, '--', ...names], { cwd: dir, env: sc.ctx.env, timeoutMs: LIMITS.shortMs });
    const line = out.stdout.split('\n').find((l) => l.startsWith('OGW_KEYS '));
    if (out.timedOut || !line) throw new OgwError(`godot could not check key names: ${(out.stderr || out.stdout).trim()}`);
    const flags = JSON.parse(line.slice('OGW_KEYS '.length)) as unknown;
    if (!Array.isArray(flags) || flags.length !== names.length) throw new OgwError('godot returned a wrong key name result');
    names.forEach((n, i) => result.set(n, flags[i] === true));
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const INHERITS_SCRIPT = `extends SceneTree

func _init() -> void:
\tvar args: PackedStringArray = OS.get_cmdline_user_args()
\tvar out: Array[bool] = []
\tfor i: int in range(1, args.size()):
\t\tout.append(ClassDB.class_exists(args[i]) and (args[i] == args[0] or ClassDB.is_parent_class(args[i], args[0])))
\tprint("OGW_INHERITS " + JSON.stringify(out))
\tquit()
`;

/** Which engine class names are `base` or inherit it in the pinned Godot (`ClassDB.is_parent_class()`). */
export async function godotInherits(sc: StaticContext, names: readonly string[], base: string): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (names.length === 0) return result;
  const godot = await godotExecutable(sc);
  const dir = await newPrivateTempFolder('ogw-classes-', sc.ctx.env);
  try {
    const script = join(dir, 'classes.gd');
    await writeFile(script, INHERITS_SCRIPT);
    const out = await run(godot, ['--headless', '--script', script, '--', base, ...names], { cwd: dir, env: sc.ctx.env, timeoutMs: LIMITS.shortMs });
    const line = out.stdout.split('\n').find((l) => l.startsWith('OGW_INHERITS '));
    if (out.timedOut || !line) throw new OgwError(`godot could not check engine classes: ${(out.stderr || out.stdout).trim()}`);
    const flags = JSON.parse(line.slice('OGW_INHERITS '.length)) as unknown;
    if (!Array.isArray(flags) || flags.length !== names.length) throw new OgwError('godot returned a wrong engine class result');
    names.forEach((n, i) => result.set(n, flags[i] === true));
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const globalNames = new WeakMap<StaticContext, Promise<Set<string>>>();

/**
 * The global names of the pinned Godot that GDScript class and enum names do not use: the engine classes, the built-in
 * types and the global enums of `godot --dump-extension-api` (`client-core` Godot `## GDScript`). Read once per static
 * check run.
 */
export function godotGlobalNames(sc: StaticContext): Promise<Set<string>> {
  let value = globalNames.get(sc);
  if (!value) {
    value = (async () => {
      const godot = await godotExecutable(sc);
      const dir = await newPrivateTempFolder('ogw-api-', sc.ctx.env);
      try {
        const out = await run(godot, ['--headless', '--dump-extension-api'], { cwd: dir, env: sc.ctx.env, timeoutMs: LIMITS.shortMs });
        const text = await readFile(join(dir, 'extension_api.json'), 'utf8').catch(whenNotFound(null));
        if (out.timedOut || text === null) throw new OgwError(`godot could not dump its extension API: ${(out.stderr || out.stdout).trim()}`);
        const api = JSON.parse(text) as { classes?: { name?: unknown }[]; builtin_classes?: { name?: unknown }[]; global_enums?: { name?: unknown }[] };
        const names = [...(api.classes ?? []), ...(api.builtin_classes ?? []), ...(api.global_enums ?? [])].map((c) => c.name);
        return new Set(names.filter((n): n is string => typeof n === 'string' && !n.includes('.')));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    })();
    globalNames.set(sc, value);
  }
  return value;
}
