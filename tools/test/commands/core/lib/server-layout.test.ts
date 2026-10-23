import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SERVER_CLOCK_LAYOUT,
  importedModule,
  importSpecifiers,
  isServerCoreTest,
  serverImplementedModules,
  serverModuleReferences,
} from '../../../../src/commands/core/lib/server-layout.ts';
import { writeFiles } from '../helpers.ts';

function temp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'ogw-server-layout-')));
}

describe('server core folder layout', () => {
  it('tells core tests apart: a module folder tests/ folder, below server/core/ or with the prefix', () => {
    expect(isServerCoreTest('storage/tests/a.test.ts')).toBe(true);
    expect(isServerCoreTest('server/core/storage/tests/fixtures/x.json')).toBe(true);
    expect(isServerCoreTest('storage/index.ts')).toBe(false);
    expect(isServerCoreTest('tests/a.ts')).toBe(false);
    expect(isServerCoreTest('storage/dev/tests.ts')).toBe(false);
    expect(isServerCoreTest('storage/tests')).toBe(false);
  });

  it('names the server-time files the static check exempts', () => {
    expect(SERVER_CLOCK_LAYOUT.isClockAdapter('server/core/server-time/adapters/system_clock.ts')).toBe(true);
    expect(SERVER_CLOCK_LAYOUT.isClockAdapter('server-time/adapters/system_clock.ts')).toBe(true);
    expect(SERVER_CLOCK_LAYOUT.isClockAdapter('server/core/server-time/scheduler.ts')).toBe(false);
    expect(SERVER_CLOCK_LAYOUT.isScheduler('server/core/server-time/scheduler.ts')).toBe(true);
    expect(SERVER_CLOCK_LAYOUT.isScheduler('server/core/server-time/network_time_limit.ts')).toBe(true);
    expect(SERVER_CLOCK_LAYOUT.isScheduler('server/core/routing/scheduler.ts')).toBe(false);
    expect(SERVER_CLOCK_LAYOUT.isTest('server/core/routing/tests/a.test.ts')).toBe(true);
  });

  it('finds modules with an entry file index.ts or dev/index.ts', async () => {
    const impl = temp();
    writeFiles(impl, {
      'server/core/storage/index.ts': '',
      'server/core/testing/dev/index.ts': '',
      'server/core/notes/readme.md': '',
      'server/core/start.ts': '',
    });
    expect(await serverImplementedModules(impl)).toEqual(['storage', 'testing']);
    expect(await serverImplementedModules(join(impl, 'missing'))).toEqual([]);
  });

  it('reads static imports, re-exports and dynamic imports', () => {
    expect(importSpecifiers("import a from '../a/index.ts';\nexport { b } from './b.ts';\nconst c = await import('../c/index.ts');\nimport type { D } from 'node:fs';\nexport const e = 1;\n"))
      .toEqual(['../a/index.ts', './b.ts', '../c/index.ts', 'node:fs']);
  });

  it('maps a relative import to the module folder it lands in', () => {
    expect(importedModule('routing/index.ts', '../storage/index.ts')).toBe('storage');
    expect(importedModule('routing/dev/x.ts', '../../cheat/dev/index.ts')).toBe('cheat');
    expect(importedModule('routing/index.ts', './a.ts')).toBe('routing');
    expect(importedModule('routing/index.ts', '../start.ts')).toBeNull();
    expect(importedModule('routing/index.ts', '../../generated/x.ts')).toBeNull();
    expect(importedModule('routing/index.ts', 'node:fs')).toBeNull();
  });

  it('collects references of module code and of DEV code, without tests and modules out of the list', async () => {
    const impl = temp();
    writeFiles(impl, {
      'server/core/routing/index.ts': "import { a } from '../storage/index.ts';\nimport { g } from '../../generated/x.ts';\nimport { o } from '../other/index.ts';\n",
      'server/core/routing/dev/d.ts': "import { c } from '../../cheat/dev/index.ts';\nimport { s } from '../../storage/index.ts';\n",
      'server/core/routing/tests/t.test.ts': "import { x } from '../../testing/dev/index.ts';\n",
      'server/core/routing/notes.md': "import { y } from '../logging/index.ts';\n",
      'server/core/storage/index.ts': "import { r } from './r.ts';\n",
    });
    const refs = await serverModuleReferences(impl, ['routing', 'storage', 'cheat', 'testing', 'logging']);
    expect(refs.get('routing')).toEqual({ code: ['storage'], dev: ['cheat', 'storage'] });
    expect(refs.get('storage')).toEqual({ code: [], dev: [] });
    expect(refs.get('cheat')).toEqual({ code: [], dev: [] });
  });
});
