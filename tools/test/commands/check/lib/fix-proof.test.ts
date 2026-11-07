import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importClient } from '../../../../src/commands/check/lib/engine.ts';
import { fixTestProofs } from '../../../../src/commands/check/lib/fix-proof.ts';
import { Slots } from '../../../../src/commands/check/lib/instances.ts';
import { clientGutRun } from '../../../../src/commands/check/lib/regression.ts';
import { runServerTests } from '../../../../src/commands/core/lib/server-tests.ts';
import type { RunState } from '../../../../src/lib/runstate.ts';
import { commitAll, makeGame, makeWorkspace } from '../../../helpers/workspace.ts';
import { ctxOf } from '../../regress/helpers.ts';

vi.mock('../../../../src/commands/check/lib/regression.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/check/lib/regression.ts')>()),
  clientGutRun: vi.fn(),
}));
vi.mock('../../../../src/commands/core/lib/server-tests.ts', () => ({ runServerTests: vi.fn() }));
vi.mock('../../../../src/commands/check/lib/engine.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/check/lib/engine.ts')>()),
  importClient: vi.fn(),
}));
vi.mock('../../../../src/commands/generate/api.ts', () => ({ generateCheckout: vi.fn(() => Promise.resolve()) }));
vi.mock('../../../../src/commands/data/lib/binary-build.ts', () => ({ binaryBuild: vi.fn(() => Promise.resolve()) }));

const R = 'records/loops/create-1';

interface Span {
  what: string;
  start: number;
  end: number;
}

const spans: Span[] = [];

async function span<T>(what: string, ms: number, value: T): Promise<T> {
  const start = Date.now();
  await new Promise((resolve) => setTimeout(resolve, ms));
  spans.push({ what, start, end: Date.now() });
  return value;
}

/** A game whose iteration added three client test files and two server test files that the report names for a fixed defect. */
async function proofGame(): Promise<{ ctx: ReturnType<typeof ctxOf>; game: Awaited<ReturnType<ReturnType<typeof ctxOf>['game']>>; run: RunState; commit: string }> {
  const ws = makeWorkspace();
  const defect = { id: 'crash', severity: 'major', owner: 'client content', where: 'w', what: 'x', why: 'y', evidence: [], source: 'play', status: 'open', refusedReason: null, repeatedDefect: 0, oscillation: 0 };
  const root = makeGame(ws, 'g', {
    'settings.json': {},
    [`${R}/content-input-1.md`]: '## kind\n\ncompleteness\n',
    [`${R}/defects.json`]: { defects: [defect], previous: null, recordedBy: 'iteration-0' },
  });
  const client = ['a', 'b', 'c'].map((n) => `client/tests/${n}/test_${n}.gd`);
  const server = ['d', 'e'].map((n) => `server/tests/${n}.test.ts`);
  for (const file of [...client, ...server]) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), 'test\n');
  }
  const named = [...client.map((f) => `\`${f}::test\``), ...server.map((f) => `\`${f}::t\``)].join(', ');
  writeFileSync(join(root, `${R}/content-1.md`), `## defects\n\n| id | result | note |\n|---|---|---|\n| crash | fixed | ${named} |\n`);
  const commit = commitAll(root, 'content agent');
  const ctx = ctxOf(ws);
  const game = await ctx.game('g');
  const run = { name: 'create-1', kind: 'loop', command: 'create', env: null, version: null, platforms: [], bundleFor: null, branch: 'main', baseCommit: '', referenceCommit: null, startedAt: 0, closedAt: null, iteration: 1, data: {} } as RunState;
  return { ctx, game, run, commit };
}

beforeEach(() => {
  spans.length = 0;
  vi.mocked(importClient).mockReset().mockImplementation(() => span('import', 40, null));
  vi.mocked(clientGutRun).mockReset().mockImplementation((_c, _root, file) =>
    span(`client ${file}`, 30, { started: true, json: { results: [{ name: `${file}::test`, status: 'fail' }] }, ran: { code: 0, signal: null, stdout: '', stderr: '', timedOut: false } } as unknown as Awaited<ReturnType<typeof clientGutRun>>),
  );
  vi.mocked(runServerTests).mockReset().mockImplementation((input) =>
    span(`server ${input.target}`, 30, { result: { results: [{ name: `${input.target}::t`, status: 'fail' }] }, timedOut: false, exitCode: 1, output: '' } as unknown as Awaited<ReturnType<typeof runServerTests>>),
  );
});

const overlap = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

describe('fixTestProofs', () => {
  it('runs the server test files beside the client import, and the test files of a kind together in free slots of the check', async () => {
    const { ctx, game, run, commit } = await proofGame();
    const proofs = await fixTestProofs(ctx, game, run, commit, { godot: 'godot', runTimeLimitMs: null, startTimeLimitMs: null, slots: new Slots(4) });
    expect(proofs.map((p) => [p.id, p.result, p.tests.map((t) => t.result)])).toEqual([['crash', 'pass', ['fail', 'fail', 'fail', 'fail', 'fail']]]);
    const of = (prefix: string): Span[] => spans.filter((s) => s.what.startsWith(prefix));
    const [imported] = of('import');
    expect(imported).toBeDefined();
    // the server runs did not wait for the import
    for (const s of of('server ')) expect(overlap(s, imported as Span)).toBe(true);
    // the client runs came after it, all three at once
    for (const s of of('client ')) expect(s.start).toBeGreaterThanOrEqual((imported as Span).end);
    const clients = of('client ');
    expect(clients).toHaveLength(3);
    expect(clients.every((a) => clients.every((b) => a === b || overlap(a, b)))).toBe(true);
    const servers = of('server ');
    expect(servers).toHaveLength(2);
    expect(overlap(servers[0] as Span, servers[1] as Span)).toBe(true);
  });

  it('runs the test files of a kind one after another when no slot of the check is free, with the same result', async () => {
    const { ctx, game, run, commit } = await proofGame();
    const slots = new Slots(1);
    await slots.acquire();
    const proofs = await fixTestProofs(ctx, game, run, commit, { godot: 'godot', runTimeLimitMs: null, startTimeLimitMs: null, slots });
    expect(proofs.map((p) => [p.id, p.result, p.tests.map((t) => t.result)])).toEqual([['crash', 'pass', ['fail', 'fail', 'fail', 'fail', 'fail']]]);
    const clients = spans.filter((s) => s.what.startsWith('client '));
    for (const [i, a] of clients.entries()) for (const b of clients.slice(i + 1)) expect(overlap(a, b)).toBe(false);
  });
});
