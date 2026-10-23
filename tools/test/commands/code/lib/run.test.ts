import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { codeCheck, coreTypeCheckAt } from '../../../../src/commands/code/lib/run.ts';
import { installPackage } from '../../../../src/commands/core/lib/engine-packages.ts';
import { requireEngine, toolProgram } from '../../../../src/commands/env/api.ts';
import { createContext } from '../../../../src/lib/command.ts';
import { commitAll, makeWorkspace, sh } from '../../../helpers/workspace.ts';

vi.mock('../../../../src/commands/env/api.ts', () => ({ requireEngine: vi.fn(), toolProgram: vi.fn() }));
vi.mock('../../../../src/commands/core/lib/engine-packages.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  installPackage: vi.fn(),
}));

function program(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

describe('codeCheck core --commit', () => {
  it('type-checks Godot scripts that extend GUT classes in the commit copy with GUT from engine.json', async () => {
    const ws = makeWorkspace();
    const engineJson = JSON.stringify({ godot: '4.5.1.stable', gut: { url: 'https://example.invalid/gut.zip', sha256: 'b'.repeat(64) } });
    write(ws.coreImpl, {
      '.gitignore': 'client/godot/addons/\nclient/godot/.godot/\n',
      'client/godot/engine.json': engineJson,
      'client/godot/project.godot': 'config_version=5\n',
      'client/godot/core/unit_test_core/dev/unit_test_case.gd': 'class_name UnitTestCase\nextends GutTest\n',
      'client/godot/core/unit_test_core/dev/gut_pre_run.gd': 'extends GutHookScript\n',
    });
    commitAll(ws.coreImpl, 'godot core');
    const commit = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    // The checkout has addons/ from `ogw core test`; the commit copy does not.
    write(ws.coreImpl, { 'client/godot/addons/gut/gut_test.gd': 'class_name GutTest\n', 'client/godot/addons/gut/hook_script.gd': 'class_name GutHookScript\n' });
    const bin = join(ws.root, 'fake-bin');
    mkdirSync(bin);
    // Fake Godot: a script whose base class is a GUT class fails unless the project has that GUT file.
    vi.mocked(requireEngine).mockResolvedValue(program(bin, 'godot', [
      'for a in "$@"; do script="$a"; done',
      'case "$*" in *--check-only*) ;; *) exit 0;; esac',
      'file="${script#res://}"',
      'for pair in GutTest:gut_test GutHookScript:hook_script; do',
      '  grep -q "^extends ${pair%%:*}$" "$file" || continue',
      '  [ -f "addons/gut/${pair#*:}.gd" ] && continue',
      '  echo "SCRIPT ERROR: Parse Error: Could not find base class \\"${pair%%:*}\\"."; echo "   at: GDScript::reload ($script:2)"; exit 1',
      'done',
      'exit 0',
    ].join('\n')));
    vi.mocked(toolProgram).mockResolvedValue(program(bin, 'gdlint', 'exit 0'));
    vi.mocked(installPackage).mockImplementation((_ctx, item, project) => {
      write(project, { 'addons/gut/gut_test.gd': 'class_name GutTest\n', 'addons/gut/hook_script.gd': 'class_name GutHookScript\n' });
      expect(item).toMatchObject({ name: 'gut', sha256: 'b'.repeat(64) });
      return Promise.resolve();
    });
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const items = await codeCheck(ctx, 'core', { commit });
    expect(items.find((item) => item.name === 'type check')).toEqual({ name: 'type check', result: 'pass', failures: [], durationMs: expect.any(Number) as number });
    expect(installPackage).toHaveBeenCalledTimes(1);
  });
});

describe('coreTypeCheckAt', () => {
  it('keeps the TypeScript failure lines when the engine part stops, with its error line, and is not complete', async () => {
    const ws = makeWorkspace();
    write(ws.coreImpl, {
      'client/godot/engine.json': JSON.stringify({ godot: '4.5.1.stable' }),
      'client/godot/a.gd': 'extends Node\n',
      'server/package.json': '{"type": "module"}\n',
      'server/core/a/index.ts': "export const a: number = 'text';\n",
    });
    commitAll(ws.coreImpl, 'core');
    const stop = 'engine godot 4.5.1.stable is not on this host. Run ogw env install-engines';
    vi.mocked(requireEngine).mockRejectedValue(new Error(stop));
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const checked = await coreTypeCheckAt(ctx, 'HEAD', ws.coreImpl);
    expect(checked).toEqual({ failures: [expect.stringMatching(/^server\/core\/a\/index\.ts:1:14 TS2322 /) as string, stop], complete: false, stops: [{ part: 'engine', reason: stop }] });
  });
});
