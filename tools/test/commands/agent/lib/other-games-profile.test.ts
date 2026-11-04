import { readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { cliToRun } from '../../../../src/commands/agent/lib/launch.ts';
import { createContext } from '../../../../src/lib/command.ts';
import { privateTempDir } from '../../../../src/lib/secret-files.ts';
import { makeGame, makeWorkspace } from '../../../helpers/workspace.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile: typeof original.writeFile = (path, ...rest) =>
    String(path).endsWith('sandbox.sb') ? Promise.reject(new Error('disk full')) : original.writeFile(path, ...rest);
  return { ...original, writeFile };
});

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('ogw agent: the block of other games after a failure', () => {
  it('removes the profile folder when the profile cannot be written, and the agent does not start', async () => {
    const ws = makeWorkspace();
    makeGame(ws, 'g', { 'settings.json': {} });
    makeGame(ws, 'other', { 'settings.json': {} });
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    await expect(cliToRun(ctx, 'content', { cli: 'claude-code', model: 'm', effort: 'high' }, await ctx.workspace(), null, null, null, 'g')).rejects.toThrow('disk full');
    expect(readdirSync(await privateTempDir(ws.env)).filter((name) => name.startsWith('ogw-content-sandbox-'))).toEqual([]);
  });
});
