import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isNamedCorePath, isNamedServerPath, namedCorePaths, namedServerPaths } from '../../../../src/commands/core/lib/named-paths.ts';
import { newTempFolder } from '../../../../src/commands/agent/lib/files.ts';

async function harness(): Promise<string> {
  const dir = await newTempFolder('ogw-named-');
  mkdirSync(join(dir, 'skills', 'server-core', 'modules'), { recursive: true });
  mkdirSync(join(dir, 'skills', 'client-core', 'engines'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'server-core', 'SKILL.md'), 'scheduler는 `server-time/scheduler.ts`, clock은 `server/core/server-time/adapters/system_clock.ts`다. `x.ts`\n- fake는 `dev/adapters/fake.ts`, DEV 진입은 `dev/index.ts`, game은 `server/main.ts`, `server/core/start.ts`다\n');
  writeFileSync(join(dir, 'skills', 'server-core', 'modules', 'server-time.md'), '');
  writeFileSync(join(dir, 'skills', 'server-core', 'modules', 'testing.md'), 'test clock은 `testing/dev/test_clock.ts`다\n');
  writeFileSync(join(dir, 'skills', 'client-core', 'engines', 'godot.md'), 'entry는 `core/bootstrap_core/core_module_entry.gd`, dev는 `res://core/bootstrap_core/dev/bootstrap_core_dev.gd`, clock은 `client/godot/core/log_core/dev/dev_test_clock.gd`다. `res://generated/core_modules.gd`, `core/ui_core/`\n');
  return dir;
}

describe('named core paths', () => {
  it('reads the paths the server-core skill and the module specs name', async () => {
    expect([...(await namedServerPaths(await harness()))].sort()).toEqual(['*/dev/adapters/fake.ts', 'server-time/adapters/system_clock.ts', 'server-time/scheduler.ts', 'testing/dev/test_clock.ts']);
  });

  it('adds the module folder paths the engine implementation rules name, as checkout relative paths', async () => {
    expect([...(await namedCorePaths(await harness()))].sort()).toEqual([
      'client/godot/core/bootstrap_core/core_module_entry.gd',
      'client/godot/core/bootstrap_core/dev/bootstrap_core_dev.gd',
      'client/godot/core/log_core/dev/dev_test_clock.gd',
      'server/core/*/dev/adapters/fake.ts',
      'server/core/server-time/adapters/system_clock.ts',
      'server/core/server-time/scheduler.ts',
      'server/core/testing/dev/test_clock.ts',
    ]);
  });

  it('matches a path relative to a module folder in every module folder', () => {
    const named = new Set(['server/core/*/dev/adapters/fake.ts', 'server/core/storage/tx.ts']);
    expect(isNamedCorePath(named, 'server/core/push/dev/adapters/fake.ts')).toBe(true);
    expect(isNamedCorePath(named, 'server/core/storage/tx.ts')).toBe(true);
    expect(isNamedCorePath(named, 'server/core/push/dev/adapters/other.ts')).toBe(false);
    expect(isNamedCorePath(named, 'server/core/dev/adapters/fake.ts')).toBe(false);
    expect(isNamedServerPath(new Set(['*/dev/adapters/fake.ts']), 'push/dev/adapters/fake.ts')).toBe(true);
    expect(isNamedServerPath(new Set(['*/dev/adapters/fake.ts']), 'dev/adapters/fake.ts')).toBe(false);
  });
});
