import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { exists } from '../../../lib/fsx.ts';
import { compareBytes } from './core-spec.ts';
import { pascalCase } from './sim.ts';

/** `client/boot/boot.gd` (`client-content` Godot `## boot and DEV code`). */
export const BOOT_GD = `extends Node


func _ready() -> void:
\tBootstrapCore.start_boot.call_deferred(ContentBoot.new())
`;

/** `client/boot/boot.tscn`: the main scene, a `Node` with `boot.gd`. */
export const BOOT_TSCN = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://boot/boot.gd" id="1_boot"]

[node name="Boot" type="Node"]
script = ExtResource("1_boot")
`;

/**
 * `resource/resources.csv.import` (`client-core` Godot `## engine meta file`): the Godot 4 import file of the "Skip"
 * import mode, as the editor's import dock saves it, so Godot neither imports the resource list file (as a translation
 * CSV) nor exports it.
 */
export const RESOURCE_LIST_IMPORT = '[remap]\n\nimporter="skip"\n';

/** `client/.gitignore` (`client-content` Godot `## project`). */
export const CLIENT_GITIGNORE = 'addons/\nandroid/\nios/plugins/\n.godot/\n';

/** Features with a DEV registration file `client/dev/features/<feature>/<feature>_dev.gd`, in byte order. */
export async function devFeatures(root: string): Promise<string[]> {
  const dir = join(root, 'client', 'dev', 'features');
  if (!exists(dir)) return [];
  const names: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && exists(join(dir, entry.name, `${entry.name}_dev.gd`))) names.push(entry.name);
  }
  return names.sort(compareBytes);
}

/**
 * `client/dev/generated/dev_registration.gd`: a `DevRegistrationList` (client core Godot `## DEV code`) whose
 * `register_all()` calls every feature's `register()` in feature name order.
 */
export function devRegistration(features: readonly string[]): string {
  const calls = features.map((feature) => `\t${pascalCase(feature)}Dev.register()`);
  return `extends DevRegistrationList


func register_all() -> void:
${calls.length > 0 ? calls.join('\n') : '\tpass'}
`;
}

/**
 * `res://generated/core_modules.gd`: `class_name CoreModules` whose `modules()` returns the module list
 * (`client-core` Godot `## module`) in the given order.
 */
export function coreModulesGd(modules: readonly string[]): string {
  const entries = modules.map((m) => `\t\t_entry("${m}", ${m}.init, ${m}.release, ${m}.is_initialized),`);
  return `class_name CoreModules
extends RefCounted


static func modules() -> Array[CoreModuleEntry]:
\tvar list: Array[CoreModuleEntry] = [
${entries.join('\n')}${entries.length > 0 ? '\n' : ''}\t]
\treturn list


static func _entry(name: String, init: Callable, release: Callable, is_initialized: Callable) -> CoreModuleEntry:
\tvar entry := CoreModuleEntry.new()
\tentry.name = name
\tentry.init = init
\tentry.release = release
\tentry.is_initialized = is_initialized
\treturn entry
`;
}
