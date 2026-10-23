import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { harnessGitDirs } from '../../../../src/commands/agent/lib/launch.ts';
import { makeWorkspace } from '../../../helpers/workspace.ts';

describe('harnessGitDirs', () => {
  it('gives the git common dir of the harness repo, and fails when it cannot be read', async () => {
    const ws = makeWorkspace();
    const dirs = await harnessGitDirs(ws, ws.env);
    expect(dirs).toContain(join(realpathSync(ws.harness), '.git'));
    // a block list without that dir would let the agent reach it: the sandbox build fails instead
    const notRepo = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-not-repo-')));
    await expect(harnessGitDirs({ ...ws, harness: notRepo }, { ...ws.env, GIT_CEILING_DIRECTORIES: tmpdir() })).rejects.toThrow();
  });
});
