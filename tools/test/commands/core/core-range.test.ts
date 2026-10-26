import { describe, expect, it } from 'vitest';
import { engineJson } from '../../../src/commands/build/lib/host.ts';
import { coreReleaseOfGame } from '../../../src/commands/core/api.ts';
import { createContext } from '../../../src/lib/command.ts';
import { makeGame, makeWorkspace, ogw, sh } from '../../helpers/workspace.ts';

/** A harness of core 0.9.0 with minCoreVersion 0.5.0, and games on cores 1.0.0 (newer) and 0.1.0 (older). */
function setup(): { ws: ReturnType<typeof makeWorkspace>; newer: string; older: string } {
  const ws = makeWorkspace({ minCoreVersion: '0.5.0' });
  sh(ws.harness, 'git', ['tag', 'core-v0.9.0']);
  const newer = makeGame(ws, 'newer', { 'settings.json': { coreVersion: '1.0.0', engine: 'godot' } });
  const older = makeGame(ws, 'older', { 'settings.json': { coreVersion: '0.1.0', engine: 'godot' } });
  return { ws, newer, older };
}

const NEWER = 'newer uses core 1.0.0, newer than this harness (core 0.9.0): use the harness at tag core-v1.0.0';
const OLDER = 'older uses core 0.1.0, older than harness settings minCoreVersion 0.5.0: raise the core of the game toward 0.9.0 (ogw core upgrade older --check prints the version it can raise to) or use the harness at tag core-v0.1.0';

describe('a game core outside the range of the harness', () => {
  it('stops ogw core fetch, ogw game check, ogw settings of core keys and ogw loop start, naming the game and the way out', async () => {
    const { ws, newer } = setup();
    for (const [game, message] of [['newer', NEWER], ['older', OLDER]] as const) {
      const fetch = await ogw(ws, ['core', 'fetch', game]);
      expect(fetch.code).toBe(1);
      expect(fetch.stderr).toContain(message);
      expect((await ogw(ws, ['game', 'check', game])).stderr).toContain(message);
      expect((await ogw(ws, ['settings', 'get', 'game', game, 'core.UICore.x'])).stderr).toContain(message);
    }
    const start = await ogw(ws, ['loop', 'start', 'newer', '--command', 'update']);
    expect(start.code).toBe(1);
    expect(start.stderr).toContain(NEWER);
    expect(sh(newer, 'git', ['branch', '--list', 'loop/*']).trim()).toBe('');
  });

  it('stops the reads of the release of a game and the engine.json of a build commit', async () => {
    const { ws } = setup();
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    await expect(coreReleaseOfGame(ctx, await ctx.game('newer'))).rejects.toThrow(NEWER);
    await expect(engineJson(ctx, await ctx.game('older'), 'godot', '0.1.0')).rejects.toThrow(OLDER);
  });
});
