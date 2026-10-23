import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPlan, emptyPlan } from '../../../../src/commands/generate/lib/apply.ts';
import { BOOT_GD, BOOT_TSCN, CLIENT_GITIGNORE, coreModulesGd, devFeatures, devRegistration } from '../../../../src/commands/generate/lib/godot-files.ts';
import { write } from '../helpers.ts';

const temp = (): string => mkdtempSync(join(tmpdir(), 'ogw-apply-'));

describe('applyPlan', () => {
  it('writes files only when the bytes differ', async () => {
    const root = temp();
    write(join(root, 'same.txt'), 'same');
    const old = new Date(2000, 0, 1);
    utimesSync(join(root, 'same.txt'), old, old);
    const plan = emptyPlan();
    plan.files.set('same.txt', 'same');
    plan.files.set('dir/new.txt', 'new');
    plan.files.set('bytes.bin', new Uint8Array([1, 2]));
    expect(await applyPlan(root, plan)).toEqual({ written: ['dir/new.txt', 'bytes.bin'], removed: [] });
    expect(statSync(join(root, 'same.txt')).mtime.getTime()).toBe(old.getTime());
    expect(readFileSync(join(root, 'dir', 'new.txt'), 'utf8')).toBe('new');
    expect(await applyPlan(root, plan)).toEqual({ written: [], removed: [] });
  });

  it('mirrors folders and keeps meta files of kept sources only', async () => {
    const root = temp();
    const source = temp();
    write(join(source, 'a', 'x.gd'), 'x2');
    write(join(source, 'y.gd'), 'y');
    write(join(root, 'core', 'a', 'x.gd'), 'x1');
    write(join(root, 'core', 'a', 'x.gd.uid'), 'uid');
    write(join(root, 'core', 'y.gd'), 'y');
    write(join(root, 'core', 'gone', 'old.gd'), 'o');
    write(join(root, 'core', 'gone', 'old.gd.uid'), 'u');
    write(join(root, 'core', 'img.png.import'), 'i');
    const plan = emptyPlan();
    plan.mirrors.push({ source, target: 'core' });
    const applied = await applyPlan(root, plan);
    expect(applied.written).toEqual(['core/a/x.gd']);
    expect(applied.removed.sort()).toEqual(['core/gone/old.gd', 'core/gone/old.gd.uid', 'core/img.png.import']);
    expect(existsSync(join(root, 'core', 'a', 'x.gd.uid'))).toBe(true);
    expect(existsSync(join(root, 'core', 'gone'))).toBe(false);
    expect(existsSync(join(root, 'core'))).toBe(true);
  });

  it('overlays folders without removing other files', async () => {
    const root = temp();
    const source = temp();
    write(join(source, 'addons', 'p', 'p.gdextension'), 'p');
    write(join(root, 'client', 'addons', 'gut', 'gut.gd'), 'g');
    const plan = emptyPlan();
    plan.overlays.push({ source, target: 'client' });
    expect(await applyPlan(root, plan)).toEqual({ written: ['client/addons/p/p.gdextension'], removed: [] });
    expect(existsSync(join(root, 'client', 'addons', 'gut', 'gut.gd'))).toBe(true);
  });

  it('makes the relative link, replaces a wrong link and refuses a real folder', async () => {
    const root = temp();
    mkdirSync(join(root, 'resource'));
    const plan = emptyPlan();
    plan.links.push({ path: 'client/resource', target: '../resource' });
    expect((await applyPlan(root, plan)).written).toEqual(['client/resource']);
    expect(readlinkSync(join(root, 'client', 'resource'))).toBe('../resource');
    expect((await applyPlan(root, plan)).written).toEqual([]);
    const wrong = temp();
    mkdirSync(join(wrong, 'client'));
    symlinkSync('../elsewhere', join(wrong, 'client', 'resource'));
    expect((await applyPlan(wrong, plan)).written).toEqual(['client/resource']);
    expect(lstatSync(join(wrong, 'client', 'resource')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(wrong, 'client', 'resource'))).toBe('../resource');
    const real = temp();
    mkdirSync(join(real, 'client', 'resource'), { recursive: true });
    await expect(applyPlan(real, plan)).rejects.toThrow('client/resource must be a symbolic link to ../resource');
  });
});

describe('coreModulesGd', () => {
  it('lists the modules in order as CoreModuleEntry items', () => {
    expect(coreModulesGd(['LogCore', 'EventCore'])).toBe(`class_name CoreModules
extends RefCounted


static func modules() -> Array[CoreModuleEntry]:
\tvar list: Array[CoreModuleEntry] = [
\t\t_entry("LogCore", LogCore.init, LogCore.release, LogCore.is_initialized),
\t\t_entry("EventCore", EventCore.init, EventCore.release, EventCore.is_initialized),
\t]
\treturn list


static func _entry(name: String, init: Callable, release: Callable, is_initialized: Callable) -> CoreModuleEntry:
\tvar entry := CoreModuleEntry.new()
\tentry.name = name
\tentry.init = init
\tentry.release = release
\tentry.is_initialized = is_initialized
\treturn entry
`);
    expect(coreModulesGd([])).toContain('\tvar list: Array[CoreModuleEntry] = [\n\t]\n');
  });
});

describe('Godot project files', () => {
  it('has the boot scene, boot script and .gitignore', () => {
    expect(BOOT_GD).toBe('extends Node\n\n\nfunc _ready() -> void:\n\tBootstrapCore.start_boot.call_deferred(ContentBoot.new())\n');
    expect(BOOT_TSCN).toContain('[ext_resource type="Script" path="res://boot/boot.gd" id="1_boot"]');
    expect(BOOT_TSCN).toContain('[node name="Boot" type="Node"]\nscript = ExtResource("1_boot")\n');
    expect(CLIENT_GITIGNORE).toBe('addons/\nandroid/\nios/plugins/\n.godot/\n');
  });

  it('lists features with a DEV registration file and writes the registration list', async () => {
    const root = temp();
    expect(await devFeatures(root)).toEqual([]);
    write(join(root, 'client', 'dev', 'features', 'shop', 'shop_dev.gd'), '');
    write(join(root, 'client', 'dev', 'features', 'daily_quest', 'daily_quest_dev.gd'), '');
    write(join(root, 'client', 'dev', 'features', 'empty', 'other.gd'), '');
    write(join(root, 'client', 'dev', 'features', 'file.gd'), '');
    expect(await devFeatures(root)).toEqual(['daily_quest', 'shop']);
    expect(devRegistration(['daily_quest', 'shop'])).toBe(
      'extends DevRegistrationList\n\n\nfunc register_all() -> void:\n\tDailyQuestDev.register()\n\tShopDev.register()\n',
    );
    expect(devRegistration([])).toBe('extends DevRegistrationList\n\n\nfunc register_all() -> void:\n\tpass\n');
  });
});
