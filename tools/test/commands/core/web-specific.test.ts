import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { webSpecificChange, webSpecificPath } from '../../../src/commands/core/lib/web-specific.ts';
import { commitAll, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';

function write(ws: TestWorkspace, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const file = join(ws.coreImpl, 'client', 'godot', path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

describe('web-specific file', () => {
  it('is engine.json, a file under core/web/ or a file with web as a word of its name', () => {
    for (const path of ['engine.json', 'core/web/ogw-shell.html', 'core/auth_core/adapters/web_storage_adapter.gd', 'core/auth_core/adapters/web_storage_adapter.gd.uid', 'core/bootstrap_core/tests/web_launch_values.json', 'core/a/google-web-sign-in.gd']) {
      expect(webSpecificPath(path)).toBe(true);
    }
    for (const path of ['core/log_core/log_core.gd', 'core/a/webhook.gd', 'core/a/cobweb_x.gd', 'project.godot']) expect(webSpecificPath(path)).toBe(false);
  });

  it('takes a change of such a file, or of a .gd file that holds browser runtime code before or after the change', async () => {
    const ws = makeWorkspace();
    write(ws, { 'core/log_core/log_core.gd': 'var x = 1\n', 'core/time_core/time_core_node.gd': 'if OS.get_name() == "Web":\n\tpass\n', 'core/a/b.gd': 'var y = 1\n' });
    const base = commitAll(ws.coreImpl, 'base');
    const changed = async (files: Record<string, string>, remove: string[] = []): Promise<boolean> => {
      write(ws, files);
      for (const path of remove) rmSync(join(ws.coreImpl, 'client', 'godot', path));
      const to = commitAll(ws.coreImpl, 'change');
      const result = await webSpecificChange(ws.coreImpl, 'godot', base, to, ws.env);
      return result;
    };
    expect(await changed({ 'core/log_core/log_core.gd': 'var x = 2\n' })).toBe(false);
    // the content before the change holds the browser runtime check
    expect(await changed({ 'core/time_core/time_core_node.gd': 'pass\n' })).toBe(true);
    // the content after the change holds it
    expect(await changed({ 'core/time_core/time_core_node.gd': 'if OS.get_name() == "Web":\n\tpass\n', 'core/a/b.gd': 'JavaScriptBridge.eval("1")\n' })).toBe(true);
    // no change
    expect(await webSpecificChange(ws.coreImpl, 'godot', base, base, ws.env)).toBe(false);
  });

  it('takes a deleted .gd file that held browser runtime code, and an added one that holds it', async () => {
    const ws = makeWorkspace();
    write(ws, { 'core/a/web_free.gd': 'x\n', 'core/a/old.gd': 'if CoreBuildInfo.platform == "web":\n\tpass\n', 'core/a/plain.gd': 'var y = 1\n' });
    const base = commitAll(ws.coreImpl, 'base');
    rmSync(join(ws.coreImpl, 'client', 'godot', 'core', 'a', 'old.gd'));
    const deleted = commitAll(ws.coreImpl, 'delete');
    expect(await webSpecificChange(ws.coreImpl, 'godot', base, deleted, ws.env)).toBe(true);
    write(ws, { 'core/a/new.gd': 'JavaScriptBridge.eval("1")\n' });
    const added = commitAll(ws.coreImpl, 'add');
    expect(await webSpecificChange(ws.coreImpl, 'godot', deleted, added, ws.env)).toBe(true);
    write(ws, { 'core/a/plain.gd': 'var y = 2\n' });
    const plain = commitAll(ws.coreImpl, 'plain');
    expect(await webSpecificChange(ws.coreImpl, 'godot', added, plain, ws.env)).toBe(false);
    // a change outside client/godot/ is not one
    writeFileSync(join(ws.coreImpl, 'web.txt'), 'x');
    expect(await webSpecificChange(ws.coreImpl, 'godot', plain, commitAll(ws.coreImpl, 'outside'), ws.env)).toBe(false);
  });
});
