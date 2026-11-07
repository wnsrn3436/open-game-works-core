import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientCheckInput } from '../../../src/commands/build/lib/client-check.ts';
import { repeatTest } from '../../../src/commands/build/lib/repeat-test.ts';
import { soakTest } from '../../../src/commands/build/lib/soak-test.ts';
import { ogw, makeWorkspace } from '../../helpers/workspace.ts';
import { commit, git, openBuildRun, setupGame, write } from './helpers.ts';

vi.mock('../../../src/commands/build/lib/repeat-test.ts', async (orig) => ({ ...(await orig<object>()), repeatTest: vi.fn() }));
vi.mock('../../../src/commands/build/lib/soak-test.ts', async (orig) => ({ ...(await orig<object>()), soakTest: vi.fn() }));

const order: string[] = [];
const inputs: { checkout: string | undefined; head: string; hasWorkspaces: boolean }[] = [];

/** A fake check that records its start and end around a delay, and the checkout it got with that checkout's HEAD. */
function traced(name: string) {
  return async (input: ClientCheckInput) => {
    order.push(`${name} start`);
    inputs.push({ checkout: input.checkout, head: git(input.checkout ?? '', 'rev-parse', 'HEAD'), hasWorkspaces: input.workspaces !== undefined });
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push(`${name} end`);
    return { name, result: 'warn' as const, details: [`${name} line`] };
  };
}

beforeEach(() => {
  order.length = 0;
  inputs.length = 0;
  vi.mocked(repeatTest).mockImplementation(traced('repeat test'));
  vi.mocked(soakTest).mockImplementation(traced('soak test'));
});

describe('build late', () => {
  it('runs the repeat test and then the soak test of the build commit in its own worktree, and writes late-checks.json', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws, 'g', { buildPlatforms: ['web'] });
    await openBuildRun(ws, dir, { platforms: ['web'] });
    const built = git(dir, 'rev-parse', 'HEAD');
    // the checkout moves on after the build commit (as the merge of ogw build finish does): the checks keep the build commit
    write(dir, 'notes.txt', 'later');
    commit(dir, 'later');
    const out = await ogw(ws, ['build', 'late', 'g', '--commit', built]);
    expect([out.code, out.stderr]).toEqual([0, '']);
    expect(order).toEqual(['repeat test start', 'repeat test end', 'soak test start', 'soak test end']);
    for (const input of inputs) {
      expect(input.checkout?.startsWith(join(ws.worktrees, 'g'))).toBe(true);
      expect(input.head).toBe(built);
      expect(input.hasWorkspaces).toBe(true);
    }
    expect(inputs[0]?.checkout).toBe(inputs[1]?.checkout);
    expect(JSON.parse(readFileSync(join(dir, 'builds/dev-0.1.0/late-checks.json'), 'utf8'))).toEqual({
      commit: built,
      checks: [{ name: 'repeat test', result: 'warn', details: ['repeat test line'] }, { name: 'soak test', result: 'warn', details: ['soak test line'] }],
    });
    expect(out.stdout).toBe('check repeat test: warn\n  repeat test line\ncheck soak test: warn\n  soak test line\n');
    // the worktree is gone
    expect(existsSync(join(ws.worktrees, 'g')) ? readdirSync(join(ws.worktrees, 'g')) : []).toEqual([]);
  });

  it('is for a DEV build run with a commit only', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws, 'g', { buildPlatforms: ['web'] });
    await openBuildRun(ws, dir, { env: 'STG', version: '0.2.0', platforms: ['web'] });
    expect((await ogw(ws, ['build', 'late', 'g', '--commit', 'HEAD'])).stderr).toContain('the late checks are of a DEV build, not of STG');
    expect(vi.mocked(repeatTest)).not.toHaveBeenCalled();
  });
});
