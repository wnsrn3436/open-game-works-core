// `ogw env check` model list and version of an agent CLI that cannot be started or whose real path cannot be read.
import { mkdirSync, symlinkSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliModelChecks, cliVersionChecks } from '../../../src/commands/env/lib/agent-clis.ts';
import type { CliStates } from '../../../src/commands/env/lib/hostcheck.ts';
import { setNet } from '../../../src/commands/env/lib/net.ts';
import { createContext } from '../../../src/lib/command.ts';
import { makeWorkspace } from '../../helpers/workspace.ts';
import { fakeBin, fakeNet } from './fakes.ts';

vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

afterEach(() => {
  setNet(null);
  vi.mocked(fsPromises.realpath).mockReset();
});

/** Every CLI installed and logged in, whatever is on PATH. */
const LOGGED_IN: CliStates = () => Promise.resolve({ installed: true, loggedIn: true, loginOutput: '' });

describe('agent CLI that cannot be started', () => {
  it('is unknown in the efforts of claude --help with the reason it cannot be started', async () => {
    const ws = makeWorkspace();
    const bin = join(ws.root, 'bin');
    // claude is a folder on PATH: spawn EACCES; codex prints an empty catalog
    mkdirSync(join(bin, 'claude'), { recursive: true });
    fakeBin(bin, { codex: 'echo \'{"models":[]}\'' });
    const env = { ...ws.env, PATH: `${bin}:/usr/bin:/bin` };
    const ctx = createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const [claude] = await cliModelChecks(ctx, LOGGED_IN);
    expect(claude?.models).toEqual([]);
    expect(claude?.unknown).toContain('efforts: cannot run claude --help: cannot run claude: spawn claude EACCES');
    expect(claude?.unknown).not.toContain('efforts: claude --help lists no levels for --effort');
  });

  it('is unknown in its version with the reason --version cannot be started', async () => {
    const ws = makeWorkspace();
    // a Homebrew cask whose program is a folder: found on PATH, but cannot be started
    const cask = join(ws.root, 'opt', 'homebrew', 'Caskroom', 'claude-code', '2.1.296', 'claude');
    mkdirSync(cask, { recursive: true });
    const links = join(ws.root, 'links');
    mkdirSync(links);
    symlinkSync(cask, join(links, 'claude'));
    setNet(fakeNet({}));
    const [check] = await cliVersionChecks({ ...ws.env, PATH: links });
    expect(check).toMatchObject({ cli: 'claude-code', installed: null, source: 'Homebrew cask claude-code', behind: null });
    expect(check?.reason).toBe('cannot run claude --version: cannot run claude: spawn claude EACCES');
  });

  it('throws when the real path of the program cannot be read', async () => {
    const ws = makeWorkspace();
    const bin = fakeBin(join(ws.root, 'bin'), { claude: 'echo "2.1.296 (Claude Code)"' });
    vi.mocked(fsPromises.realpath).mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied, realpath'), { code: 'EACCES' }));
    await expect(cliVersionChecks({ ...ws.env, PATH: bin })).rejects.toThrow('EACCES: permission denied, realpath');
  });
});
