// A caught error of the loop commands: only the expected error becomes a value; every other one fails.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { iterationRecords } from '../../../../src/commands/loop/lib/iteration-record.ts';
import { botRun, checkTelemetryRuns, telemetryRunsRel } from '../../../../src/commands/loop/lib/shared-telemetry.ts';
import type { Context } from '../../../../src/lib/command.ts';
import type { GameRepo } from '../../../../src/lib/game.ts';
import type { RunState } from '../../../../src/lib/runstate.ts';

const bot = vi.hoisted(() => ({ run: null as Error | null, telemetry: null as Error | null }));

vi.mock('../../../../src/commands/check/lib/scenario.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/check/lib/scenario.ts')>()),
  runScenario: vi.fn(() => (bot.run === null ? Promise.resolve({ stop: null, goal: true }) : Promise.reject(bot.run))),
}));
vi.mock('../../../../src/commands/telemetry/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/telemetry/api.ts')>()),
  readTelemetry: vi.fn(() => (bot.telemetry === null ? Promise.resolve({ started_at: 0 }) : Promise.reject(bot.telemetry))),
}));

function game(): GameRepo {
  return { root: mkdtempSync(join(tmpdir(), 'ogw-caught-')), name: 'g' } as GameRepo;
}

const RUN = { name: 'update-1' } as RunState;
const WANT = { commit: 'c', baseline: 'b', scenario: 's' };

beforeEach(() => {
  bot.run = null;
  bot.telemetry = null;
});

describe('checkTelemetryRuns', () => {
  it('takes no runs without the file or from a file that is not JSON, and fails on a file that cannot be read', async () => {
    const g = game();
    const path = join(g.root, telemetryRunsRel(RUN, 1));
    expect(await checkTelemetryRuns(g, RUN, 1, WANT)).toBeNull();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json');
    expect(await checkTelemetryRuns(g, RUN, 1, WANT)).toBeNull();
    writeFileSync(path, JSON.stringify({ ...WANT, runs: { commit: null, baseline: null } }));
    expect(await checkTelemetryRuns(g, RUN, 1, WANT)).toEqual({ commit: null, baseline: null });
    const unreadable = join(g.root, telemetryRunsRel(RUN, 2));
    mkdirSync(unreadable, { recursive: true });
    await expect(checkTelemetryRuns(g, RUN, 2, WANT)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('botRun', () => {
  const ctx = {} as Context;
  const scenario = { steps: [], goal: null } as unknown as Parameters<typeof botRun>[2];

  it('gives the telemetry and the play guide of the instance, null without a play guide', async () => {
    const root = game().root;
    expect(await botRun(ctx, { id: 'i1', root }, scenario, 1)).toEqual({ telemetry: { started_at: 0 }, guide: null });
    writeFileSync(join(root, 'play-guide.md'), 'guide');
    expect(await botRun(ctx, { id: 'i1', root }, scenario, 1)).toEqual({ telemetry: { started_at: 0 }, guide: 'guide' });
  });

  it('fails with the error of a run, a telemetry read or a play guide read that failed, for the caller to say why', async () => {
    const root = game().root;
    bot.run = new Error('automation channel closed');
    await expect(botRun(ctx, { id: 'i1', root }, scenario, 1)).rejects.toThrow('automation channel closed');
    bot.run = null;
    bot.telemetry = new Error('get_telemetry failed');
    await expect(botRun(ctx, { id: 'i1', root }, scenario, 1)).rejects.toThrow('get_telemetry failed');
    bot.telemetry = null;
    mkdirSync(join(root, 'play-guide.md'));
    await expect(botRun(ctx, { id: 'i1', root }, scenario, 1)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('iterationRecords', () => {
  it('has none without the run folder, and fails on a run folder that cannot be read', async () => {
    const g = game();
    expect(await iterationRecords(g, RUN)).toEqual([]);
    mkdirSync(join(g.root, 'records', 'loops'), { recursive: true });
    writeFileSync(join(g.root, 'records', 'loops', RUN.name), 'a file');
    await expect(iterationRecords(g, RUN)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
