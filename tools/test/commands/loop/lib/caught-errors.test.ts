// A caught error of the loop commands: only the expected error becomes a value; every other one fails.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { iterationRecords } from '../../../../src/commands/loop/lib/iteration-record.ts';
import type { GameRepo } from '../../../../src/lib/game.ts';
import type { RunState } from '../../../../src/lib/runstate.ts';

function game(): GameRepo {
  return { root: mkdtempSync(join(tmpdir(), 'ogw-caught-')), name: 'g' } as GameRepo;
}

const RUN = { name: 'update-1' } as RunState;

describe('iterationRecords', () => {
  it('has none without the run folder, and fails on a run folder that cannot be read', async () => {
    const g = game();
    expect(await iterationRecords(g, RUN)).toEqual([]);
    mkdirSync(join(g.root, 'records', 'loops'), { recursive: true });
    writeFileSync(join(g.root, 'records', 'loops', RUN.name), 'a file');
    await expect(iterationRecords(g, RUN)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
