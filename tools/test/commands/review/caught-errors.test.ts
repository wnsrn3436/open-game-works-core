// A caught error of the review commands: only the expected error becomes a value; every other one fails.
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkoutLine } from '../../../src/commands/review/lib/debt.ts';
import { removeToolReviewFiles } from '../../../src/commands/review/lib/state.ts';
import { createContext } from '../../../src/lib/command.ts';
import { jobWorkspace } from '../job/helpers.ts';

describe('removeToolReviewFiles', () => {
  it('removes nothing for a review job whose record is gone, and fails on a record that cannot be read', async () => {
    const ws = jobWorkspace();
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    await expect(removeToolReviewFiles(ctx, [{ reviewFile: null, reviewJob: 'gone1' }])).resolves.toBeUndefined();
    mkdirSync(join(ws.jobs, 'broken1.json'));
    await expect(removeToolReviewFiles(ctx, [{ reviewFile: null, reviewJob: 'broken1' }])).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('checkoutLine', () => {
  it('reads a root that is gone through its nearest folder, and fails on a root that cannot be resolved', () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-caught-'));
    const gone = join(root, 'worktree-gone');
    expect(checkoutLine(`${gone}/src/a.ts:3: high a bug`, [gone])).toBe('src/a.ts:3: high a bug');
    symlinkSync(join(root, 'b'), join(root, 'a'));
    symlinkSync(join(root, 'a'), join(root, 'b'));
    expect(() => checkoutLine(`${root}/elsewhere/a.ts:3: high a bug`, [join(root, 'a')])).toThrow(/ELOOP/);
  });
});
