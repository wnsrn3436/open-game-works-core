import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serverCoreFindings, serverCoreStaticCheck, serverFileFindings } from '../../../../src/commands/core/lib/core-server-static-check.ts';
import { SERVER_CLOCK_LAYOUT as layout } from '../../../../src/commands/core/lib/server-layout.ts';
import { writeFiles } from '../helpers.ts';


const SOURCE = [
  "import { setTimeout as wait } from 'node:timers/promises';",
  "import { readFile } from 'node:fs/promises';",
  'export function f(): bigint {',
  '  const a = Date.now() + performance.now();',
  '  const d = new Date();',
  '  const e = new Date(0);',
  '  setTimeout(() => undefined, 5);',
  '  globalThis.setInterval(() => undefined, 5);',
  '  const s = AbortSignal.timeout(10);',
  '  void readFile; void wait; void s; void d; void e;',
  '  return BigInt(a);',
  '}',
  '',
].join('\n');

describe('server core static check', () => {
  it('flags system clock reads outside the clock adapter and timers outside the scheduler', () => {
    expect(serverFileFindings('server/core/routing/a.ts', SOURCE, layout)).toEqual([
      'server/core/routing/a.ts:1: timer: import of `node:timers/promises` outside server-time schedule_job, sleep and network_time_limit',
      'server/core/routing/a.ts:4: system clock: `Date.now()` outside the clock adapter',
      'server/core/routing/a.ts:4: system clock: `performance.now()` outside the clock adapter',
      'server/core/routing/a.ts:5: system clock: `new Date()` outside the clock adapter',
      'server/core/routing/a.ts:7: timer: `setTimeout()` outside server-time schedule_job, sleep and network_time_limit',
      'server/core/routing/a.ts:8: timer: `globalThis.setInterval()` outside server-time schedule_job, sleep and network_time_limit',
      'server/core/routing/a.ts:9: timer: `AbortSignal.timeout()` outside server-time schedule_job, sleep and network_time_limit',
    ]);
    expect(serverFileFindings('server/core/server-time/adapters/system_clock.ts', SOURCE, layout).filter((l) => l.includes('system clock'))).toEqual([]);
    expect(serverFileFindings('server/core/server-time/scheduler.ts', SOURCE, layout).filter((l) => l.includes('timer'))).toEqual([]);
  });

  it('reads the TypeScript files of server/core/ except core tests', async () => {
    const impl = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-core-server-static-')));
    writeFiles(impl, {
      'server/core/server-time/adapters/system_clock.ts': 'export const now = (): number => Date.now();\n',
      'server/core/server-time/tests/clock.test.ts': 'Date.now();\n',
      'server/core/storage/a.mts': 'export const t = Date.now();\n',
      'server/core/storage/notes.md': 'Date.now()\n',
    });
    expect(await serverCoreFindings(impl, layout)).toEqual(['server/core/storage/a.mts:1: system clock: `Date.now()` outside the clock adapter']);
    expect(await serverCoreFindings(join(impl, 'missing'), layout)).toEqual([]);
  });

  it('exempts the network_time_limit file from the timer rule and checks the layout of server-core ## folder', async () => {
    expect(serverFileFindings('server/core/server-time/network_time_limit.ts', SOURCE, layout).filter((l) => l.includes('timer'))).toEqual([]);
    expect(serverFileFindings('server/core/server-time/network_time_limit.ts', SOURCE, layout).filter((l) => l.includes('system clock'))).toHaveLength(3);
    const impl = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-core-server-static-')));
    writeFiles(impl, {
      'server/core/server-time/adapters/system_clock.ts': 'export const now = (): number => Date.now();\n',
      'server/core/server-time/scheduler.ts': 'setTimeout(() => undefined, 1);\n',
      'server/core/server-time/tests/a.test.ts': 'setTimeout(() => undefined, 1);\n',
      'server/core/routing/index.ts': 'setInterval(() => undefined, 1);\n',
    });
    expect(await serverCoreStaticCheck(impl)).toEqual(['server/core/routing/index.ts:1: timer: `setInterval()` outside server-time schedule_job, sleep and network_time_limit']);
  });
});
