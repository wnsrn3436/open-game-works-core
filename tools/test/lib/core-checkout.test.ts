import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCoreImpl } from '../../src/lib/game.ts';
import { loadHarnessSettings, workspaceFrom, type Workspace } from '../../src/lib/settings.ts';
import { gitInit, makeWorkspace, sh, type TestWorkspace } from '../helpers/workspace.ts';

async function workspaceOf(ws: TestWorkspace): Promise<Workspace> {
  return workspaceFrom(await loadHarnessSettings(ws.env), ws.env);
}

/** A core tree: `core-spec/` and `settings/core-settings.json`. */
function coreTree(dir: string): void {
  mkdirSync(join(dir, 'core-spec'), { recursive: true });
  writeFileSync(join(dir, 'core-spec', 'UICore.json'), '{}\n');
  mkdirSync(join(dir, 'settings'), { recursive: true });
  writeFileSync(join(dir, 'settings', 'core-settings.json'), '{}\n');
}

describe('core checkout', () => {
  it('is the git worktree of open-game-works-core-impl/ that holds the current folder, else the main checkout', async () => {
    const ws = makeWorkspace();
    const workspace = await workspaceOf(ws);
    coreTree(ws.coreImpl);
    sh(ws.coreImpl, 'git', ['add', '--all']);
    sh(ws.coreImpl, 'git', ['commit', '--quiet', '-m', 'tree']);
    expect(await resolveCoreImpl(workspace, ws.root, ws.env)).toBe(ws.coreImpl);
    expect(await resolveCoreImpl(workspace, join(ws.coreImpl, 'settings'), ws.env)).toBe(ws.coreImpl);
    // a worktree outside worktrees/_core/, such as a temporary one of a review agent
    const temp = join(ws.root, 'scratch', 'rev-a');
    sh(ws.coreImpl, 'git', ['worktree', 'add', '--quiet', '--detach', temp, 'HEAD']);
    expect(realpathSync(await resolveCoreImpl(workspace, join(temp, 'core-spec'), ws.env))).toBe(realpathSync(temp));
    // a worktree under worktrees/_core/
    const agent = join(ws.worktrees, '_core', 'agent-x');
    sh(ws.coreImpl, 'git', ['worktree', 'add', '--quiet', '--detach', agent, 'HEAD']);
    expect(realpathSync(await resolveCoreImpl(workspace, agent, ws.env))).toBe(realpathSync(agent));
  });

  it('refuses a core tree that is not a git worktree of open-game-works-core-impl/, and names the command that makes one', async () => {
    const ws = makeWorkspace();
    const workspace = await workspaceOf(ws);
    const copy = join(ws.root, 'scratch', 'copy');
    coreTree(copy);
    const message = `${copy} is a core tree that is not a git worktree of ${ws.coreImpl}; a core command works in a worktree of it: git -C ${ws.coreImpl} worktree add <folder>`;
    await expect(resolveCoreImpl(workspace, join(copy, 'core-spec'), ws.env)).rejects.toThrow(message);
    // a copy that is a repo of its own is no worktree of it either
    gitInit(copy);
    await expect(resolveCoreImpl(workspace, copy, ws.env)).rejects.toThrow(message);
    // a folder that is no core tree (a game, the harness) works in the main checkout
    expect(await resolveCoreImpl(workspace, ws.harness, ws.env)).toBe(ws.coreImpl);
  });
});
