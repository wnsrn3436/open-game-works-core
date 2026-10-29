import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { benchmarkDataViolations } from '../../../../src/commands/core/lib/benchmark-data.ts';
import { dataToolArgs } from '../../../../src/commands/data/api.ts';
import { makeWorkspace, sh } from '../../../helpers/workspace.ts';
import { writeImpl } from '../impl-fixture.ts';

/** The module names of the `core-spec.json` that each data tool run got. */
const specModules: string[][] = [];
vi.mock('../../../../src/commands/data/api.ts', async () => {
  const { readFileSync: read } = await import('node:fs');
  const { join: joinPath } = await import('node:path');
  return {
    dataToolArgs: vi.fn((_ctx: unknown, input: { release: { dir: string } }) => {
      const spec = JSON.parse(read(joinPath(input.release.dir, 'core-spec.json'), 'utf8')) as { modules: { name: string }[] };
      specModules.push(spec.modules.map((m) => m.name).sort());
      return Promise.resolve(['--binary']);
    }),
  };
});
vi.mock('../../../../src/commands/core/lib/tools.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // the run gets the copy of the benchmark game as cwd; the stand-in data tool fails when its translation is stale
  withBuiltTool: (_env: unknown, _impl: string, _tool: string, fn: (entry: string) => unknown) => fn((_env as NodeJS.ProcessEnv).STAND_IN_TOOL ?? ''),
}));

/** A data tool stand-in: exits 1 with the data tool message when the copy's `stale` file exists. */
const STAND_IN = join(import.meta.dirname, 'benchmark-data-tool.mjs');

describe('benchmark data release condition', () => {
  it('passes a benchmark game whose data the binary build accepts, and gives the binary build the modules of the impl', async () => {
    const ws = makeWorkspace();
    writeImpl(ws.coreImpl);
    expect(await benchmarkDataViolations({ env: { ...ws.env, STAND_IN_TOOL: STAND_IN } } as never, ws.coreImpl)).toEqual([]);
    const input = vi.mocked(dataToolArgs).mock.calls[0]?.[1];
    if (input === undefined) throw new Error('the data tool did not run');
    expect(input.binary).toBe(true);
    expect(input.toolDir).toBe(ws.coreImpl);
    expect(input.idRegistry).toBe(join(input.gameDir, 'id_registry.json'));
    expect(specModules[0]).toEqual(['LogCore', 'UICore', 'routing']);
  });

  it('reports a benchmark game whose data the binary build refuses, and skips an engine without a benchmark game', async () => {
    const ws = makeWorkspace();
    writeImpl(ws.coreImpl);
    sh(ws.coreImpl, 'touch', ['benchmark/godot/stale']);
    expect(await benchmarkDataViolations({ env: { ...ws.env, STAND_IN_TOOL: STAND_IN } } as never, ws.coreImpl)).toEqual([
      'benchmark godot: the data tool binary build failed (1)\n  the data is not matched; run the data tool without --binary and commit: data/translations/en.csv',
    ]);
    sh(ws.coreImpl, 'rm', ['-r', 'benchmark']);
    expect(await benchmarkDataViolations({ env: { ...ws.env, STAND_IN_TOOL: STAND_IN } } as never, ws.coreImpl)).toEqual([]);
  });
});
