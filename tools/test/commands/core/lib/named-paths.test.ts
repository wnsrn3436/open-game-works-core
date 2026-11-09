import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isNamedServerPath, namedServerPaths } from '../../../../src/commands/core/lib/named-paths.ts';
import { newTempFolder } from '../../../../src/commands/agent/lib/files.ts';

async function harness(): Promise<string> {
  const dir = await newTempFolder('ogw-named-');
  mkdirSync(join(dir, 'skills', 'server-core', 'modules'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'server-core', 'SKILL.md'), 'scheduler는 `server-time/scheduler.ts`, clock은 `server/core/server-time/adapters/system_clock.ts`다. `x.ts`\n- fake는 `dev/adapters/fake.ts`, DEV 진입은 `dev/index.ts`, game은 `server/main.ts`, `server/core/start.ts`다\n');
  writeFileSync(join(dir, 'skills', 'server-core', 'modules', 'server-time.md'), '');
  writeFileSync(join(dir, 'skills', 'server-core', 'modules', 'testing.md'), 'test clock은 `testing/dev/test_clock.ts`다\n');
  return dir;
}

describe('named server paths', () => {
  it('reads the paths the server-core skill and the module specs name', async () => {
    expect([...(await namedServerPaths(await harness()))].sort()).toEqual(['*/dev/adapters/fake.ts', 'server-time/adapters/system_clock.ts', 'server-time/scheduler.ts', 'testing/dev/test_clock.ts']);
  });

  it('matches a path relative to a module folder in every module folder', () => {
    const named = new Set(['*/dev/adapters/fake.ts', 'storage/tx.ts']);
    expect(isNamedServerPath(named, 'push/dev/adapters/fake.ts')).toBe(true);
    expect(isNamedServerPath(named, 'storage/tx.ts')).toBe(true);
    expect(isNamedServerPath(named, 'push/dev/adapters/other.ts')).toBe(false);
    expect(isNamedServerPath(named, 'dev/adapters/fake.ts')).toBe(false);
  });
});
