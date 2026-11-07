import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { regressChecks } from '../../../../src/commands/check/check.ts';
import { importClient } from '../../../../src/commands/check/lib/engine.ts';
import { fixTestProofs } from '../../../../src/commands/check/lib/fix-proof.ts';
import { clientGutRun, serverTestRun } from '../../../../src/commands/check/lib/regression.ts';
import { StaticContext } from '../../../../src/commands/check/static/lib/context.ts';
import * as typeCheck from '../../../../src/commands/check/static/type-check.ts';
import { withHeavyStep } from '../../../../src/commands/generation/lib/lease.ts';
import type { RunState } from '../../../../src/lib/runstate.ts';
import { commitAll, makeGame, makeWorkspace } from '../../../helpers/workspace.ts';
import { ctxOf } from '../../regress/helpers.ts';

/** The steps that ran, each with whether it ran inside a heavy step (`withHeavyStep`). */
const ran: string[] = [];
let depth = 0;
function step<T>(what: string, value: T): Promise<T> {
  ran.push(`${what}${depth > 0 ? ' inside a heavy step' : ''}`);
  return Promise.resolve(value);
}

vi.mock('../../../../src/commands/generation/lib/lease.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/generation/lib/lease.ts')>()),
  withHeavyStep: vi.fn(async (_ctx: unknown, _game: unknown, fn: () => Promise<unknown>) => {
    depth += 1;
    try {
      return await fn();
    } finally {
      depth -= 1;
    }
  }),
}));
vi.mock('../../../../src/commands/core/lib/server-tests.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/core/lib/server-tests.ts')>()),
  runServerTests: vi.fn(() => step('server test run', { result: { results: [] }, timedOut: false, exitCode: 0, output: '' })),
}));
vi.mock('../../../../src/commands/core/lib/godot.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/core/lib/godot.ts')>()),
  gutRun: vi.fn(() => step('GUT run', { started: true, json: { results: [] }, ran: { code: 0, signal: null, stdout: '', stderr: '', timedOut: false } })),
}));
vi.mock('../../../../src/commands/generate/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/generate/api.ts')>()),
  installEnginePackages: vi.fn(() => step('client import', [])),
  generateCheckout: vi.fn(() => step('generated files', [])),
}));
vi.mock('../../../../src/commands/data/lib/binary-build.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/data/lib/binary-build.ts')>()),
  binaryBuild: vi.fn(() => step('data binary build', undefined)),
}));
vi.mock('../../../../src/commands/code/gdscript-checks.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/code/gdscript-checks.ts')>()),
  godotTypeCheck: vi.fn(() => step('godot type check', [])),
}));
vi.mock('../../../../src/commands/check/static/lib/off-thread.ts', () => ({ offThread: vi.fn(() => step('tsc', [])) }));
vi.mock('../../../../src/commands/check/static/lib/engine.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/check/static/lib/engine.ts')>()),
  godotExecutable: vi.fn(() => Promise.resolve('godot')),
}));
vi.mock('../../../../src/commands/check/lib/engine.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/check/lib/engine.ts')>()),
  gameEngine: vi.fn(() => Promise.resolve('/nonexistent/godot')),
}));
vi.mock('../../../../src/commands/check/lib/loop.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/check/lib/loop.ts')>()),
  gameChecks: vi.fn(() => Promise.resolve([])),
}));

const R = 'records/loops/regress-1-1';

beforeEach(() => {
  ran.length = 0;
  vi.mocked(withHeavyStep).mockClear();
});

describe('the heavy steps of a check', () => {
  it('run the client import, the GUT runs, the server test runs, the type check, the data binary builds and the generated files of the fix test proof each as a heavy step', async () => {
    const ws = makeWorkspace({ maxConcurrentInstances: 4 });
    const defect = { id: 'crash', severity: 'major', owner: 'server content', where: 'w', what: 'x', why: 'y', evidence: [], source: 'play', status: 'open', refusedReason: null, repeatedDefect: 0, oscillation: 0 };
    const root = makeGame(ws, 'g', {
      'settings.json': {},
      'client/a.gd': 'extends Node\n',
      'server/a.ts': 'export const a = 1;\n',
      [`${R}/content-input-1.md`]: '## kind\n\ncompleteness\n',
      [`${R}/defects.json`]: { defects: [defect], previous: null, recordedBy: 'ogw regress run' },
    });
    commitAll(root, 'base');
    mkdirSync(join(root, 'server/tests'), { recursive: true });
    writeFileSync(join(root, 'server/tests/a.test.ts'), 'test\n');
    writeFileSync(join(root, `${R}/content-1.md`), '## defects\n\n| id | result | note |\n|---|---|---|\n| crash | fixed | `server/tests/a.test.ts::t` |\n');
    const commit = commitAll(root, 'fix');
    const ctx = ctxOf(ws);
    const game = await ctx.game('g');
    const limits = { godot: '/nonexistent/godot', runTimeLimitMs: null, startTimeLimitMs: null };
    await importClient(ctx, '/nonexistent/godot', game);
    await clientGutRun(ctx, game, 'client/tests', limits);
    await serverTestRun(ctx, game, 'server/tests', { serverModules: '', serverData: '', sharedFixtures: '', coreFixtures: null, postgresql: null, defaultDb: 'sqlite' }, 1000);
    const sc = new StaticContext(ctx, game, ['client/a.gd', 'server/a.ts']);
    sc.imported = true;
    await typeCheck.run(sc);
    const run = { name: 'regress-1-1', kind: 'loop', command: null, env: null, version: null, platforms: [], bundleFor: null, branch: 'main', baseCommit: '', referenceCommit: null, startedAt: 0, closedAt: null, iteration: 1, data: {} } as RunState;
    await fixTestProofs(ctx, game, run, commit, limits);
    await regressChecks(ctx, game, { root, dir: null, relative: false }, { only: null, performance: false }, null);
    expect([...ran].sort()).toEqual([
      'client import inside a heavy step',
      'GUT run inside a heavy step',
      'server test run inside a heavy step',
      'godot type check inside a heavy step',
      'tsc inside a heavy step',
      // the fix test proof: its generated files and data binaries, then its server test file
      'generated files inside a heavy step',
      'data binary build inside a heavy step',
      'server test run inside a heavy step',
      // the data binary build of the check
      'data binary build inside a heavy step',
    ].sort());
    // each heavy step is one of its own: none waits for the lease inside another
    expect(vi.mocked(withHeavyStep).mock.calls).toHaveLength(8);
  });
});
