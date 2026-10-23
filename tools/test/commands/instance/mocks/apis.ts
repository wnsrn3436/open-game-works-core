// Implementations of the cross-group APIs the runner calls, for vi.mock factories.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '../../../../src/lib/command.ts';
import type { GameRepo } from '../../../../src/lib/game.ts';
import { checkoutLock } from '../../../../src/lib/git.ts';
import { mockState } from './state.ts';

export const generate = {
  /** Takes the lock path the real `ogw generate` takes, so a checkout it cannot lock fails here too. */
  async runGenerate(ctx: Context, game: GameRepo): Promise<void> {
    mockState.generateLocks.push(await checkoutLock(game.root, 'ogw-generate.lock', { env: ctx.env }));
    mockState.generateCalls.push(game.root);
  },
  mergedCoreSettings(): Promise<Record<string, unknown>> {
    return Promise.resolve(mockState.core);
  },
  gameModules(): Promise<{ client: string[]; server: string[] }> {
    return Promise.resolve(mockState.modules);
  },
};

export const data = {
  async runData(ctx: Context, game: GameRepo, options?: { binary?: boolean; generate?: boolean }) {
    if (options?.binary === true) mockState.generateLocks.push(await checkoutLock(game.root, 'ogw-generate.lock', { env: ctx.env }));
    mockState.dataCalls.push({ root: game.root, binary: options?.binary === true, generate: options?.generate !== false });
    const failed = mockState.dataExit !== 0;
    return {
      exitCode: mockState.dataExit,
      lines: failed ? [{ level: 'ERROR', code: 'bad', where: 'x.csv:5', message: 'bad', text: 'ERROR bad x.csv:5 bad' }] : [],
      stderr: '',
    };
  },
};

export const core = {
  coreReleaseOfGame() {
    return Promise.resolve({ version: '1.0.0', dir: '/nonexistent', local: false });
  },
  extractedAsset(_ctx: Context, _release: unknown, asset: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-asset-'));
    if (asset === 'client-godot.zip') writeFileSync(join(dir, 'engine.json'), JSON.stringify({ godot: mockState.engineVersion }));
    return Promise.resolve(dir);
  },
};

export const env = {
  requireEngine(_ctx: Context, engine: string, version: string): Promise<string> {
    mockState.engineRequests.push([engine, version]);
    return Promise.resolve(mockState.enginePath);
  },
  toolProgram(): Promise<string | null> {
    return Promise.resolve(mockState.ffmpeg);
  },
  enginePath(): Promise<string | null> {
    return Promise.resolve(mockState.enginePath);
  },
  installEngines(): Promise<void> {
    return Promise.resolve();
  },
};

const fakes = join(dirname(fileURLToPath(import.meta.url)), '..', 'fakes');

type LaunchModule = typeof import('../../../../src/commands/instance/lib/launch.ts');

export function launchOverrides(real: LaunchModule): Pick<LaunchModule, 'serverLaunch' | 'populateLaunch'> {
  return {
    serverLaunch(start) {
      mockState.serverLaunches.push(start);
      const args = [join(fakes, 'fake-server.mjs'), ...real.serverStartArgs(start)];
      return { command: process.execPath, args, cwd: start.root };
    },
    populateLaunch(target) {
      mockState.populateCalls.push(target);
      const code = mockState.populateFails ? 'console.error("populate broke"); process.exit(2)' : 'process.exit(0)';
      return { command: process.execPath, args: ['-e', code], cwd: target.root };
    },
  };
}
