// The probes of `ogw env check` and `ogw build start`: a program that is not on this host is the absent result, and a
// program that is there but cannot be started (here a folder named like it on PATH: spawn EACCES) is thrown.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeBuildTool } from '../../../../src/commands/env/api.ts';
import { whichIn } from '../../../../src/commands/env/lib/host.ts';
import { cliStates, deviceChecks, hostInfo } from '../../../../src/commands/env/lib/hostcheck.ts';
import { ghStatus, probeProgram, programMissing } from '../../../../src/commands/env/lib/probe.ts';
import { postgresPresent } from '../../../../src/commands/env/lib/tools.ts';
import { createContext, type Context } from '../../../../src/lib/command.ts';
import { OgwError } from '../../../../src/lib/errors.ts';
import type { HarnessSettings } from '../../../../src/lib/settings.ts';
import { makeWorkspace, type TestWorkspace } from '../../../helpers/workspace.ts';

interface Paths {
  ws: TestWorkspace;
  /** PATH with no program. */
  empty: NodeJS.ProcessEnv;
  /** PATH whose `name` is a folder: found, but cannot be started. */
  folder: (name: string) => NodeJS.ProcessEnv;
}

function paths(): Paths {
  const ws = makeWorkspace();
  const none = join(ws.root, 'no-programs');
  mkdirSync(none);
  return {
    ws,
    empty: { ...ws.env, PATH: none },
    folder: (name) => {
      const bin = join(ws.root, `bin-${name}`);
      mkdirSync(join(bin, name), { recursive: true });
      return { ...ws.env, PATH: bin };
    },
  };
}

function context(ws: TestWorkspace, env: NodeJS.ProcessEnv): Context {
  return createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
}

const CANNOT_START = /^cannot run \S+: spawn \S+ EACCES$/;

describe('programMissing', () => {
  it('is a spawn ENOENT only', () => {
    expect(programMissing(new OgwError('cannot run git: spawn git ENOENT'))).toBe(true);
    expect(programMissing(new OgwError('cannot run /a b/c: spawn /a b/c ENOENT'))).toBe(true);
    expect(programMissing(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true);
    expect(programMissing(new OgwError('cannot run git: spawn git EACCES'))).toBe(false);
    expect(programMissing(new Error('cannot run git: spawn git ENOENT'))).toBe(false);
  });
});

describe('program probes', () => {
  it('reads a program that is not on this host as missing, and throws one that cannot be started', async () => {
    const { empty, folder } = paths();
    expect(await probeProgram(empty, 'git', ['--version'])).toEqual({ found: false, version: null });
    await expect(probeProgram(folder('git'), 'git', ['--version'])).rejects.toThrow(CANNOT_START);
    expect(await ghStatus(empty)).toEqual({ loggedIn: false, scopes: [] });
    await expect(ghStatus(folder('gh'))).rejects.toThrow(CANNOT_START);
  });

  it('reads the postgres image as absent without docker, and throws a docker that cannot be started', async () => {
    const { ws, empty, folder } = paths();
    const pin = { tag: '18', digest: 'sha256:x' };
    expect(await postgresPresent(context(ws, empty), pin)).toBe(false);
    await expect(postgresPresent(context(ws, folder('docker')), pin)).rejects.toThrow(CANNOT_START);
  });

  it('reads a build tool not on PATH as not ok with no output, and throws one that cannot be started', async () => {
    const { ws, empty, folder } = paths();
    const tool = { name: 'xcode', version: '26.0', versionCommand: 'xcodebuild -version' };
    expect(await probeBuildTool(context(ws, empty), tool)).toEqual({ downloadable: false, ok: false, output: null });
    await expect(probeBuildTool(context(ws, folder('xcodebuild')), tool)).rejects.toThrow(CANNOT_START);
  });

  it('reads no test device as connected without adb, and throws an adb that cannot be started', async () => {
    const { ws, empty, folder } = paths();
    const settings = { testDevices: [{ serial: 'emu1' }] } as unknown as HarnessSettings;
    expect(await deviceChecks(context(ws, empty), settings)).toEqual([{ serial: 'emu1', connected: false, udp: null }]);
    await expect(deviceChecks(context(ws, folder('adb')), settings)).rejects.toThrow(CANNOT_START);
  });

  it('reads a CLI not on PATH as not installed, and throws the login check of an installed CLI that cannot be started', async () => {
    const { empty, folder } = paths();
    const def = { program: 'claude', login: ['auth', 'status'] };
    expect(await cliStates(empty)(def)).toEqual({ installed: false, loggedIn: false, loginOutput: '' });
    await expect(cliStates(folder('claude'))(def)).rejects.toThrow(CANNOT_START);
  });
});

describe('whichIn', () => {
  it('passes over what is no program and throws any other failure to look', async () => {
    const { ws } = paths();
    const bin = join(ws.root, 'which');
    mkdirSync(bin);
    // not executable, a PATH entry that is a file, absent: no program
    writeFileSync(join(bin, 'plain'), 'x');
    writeFileSync(join(ws.root, 'file-entry'), 'x');
    const env = { PATH: `${join(ws.root, 'file-entry')}:${bin}` };
    expect(await whichIn(env, 'plain')).toBeNull();
    expect(await whichIn(env, 'absent')).toBeNull();
    // a link that points at itself cannot be looked at: ELOOP
    symlinkSync(join(bin, 'loop'), join(bin, 'loop'));
    await expect(whichIn(env, 'loop')).rejects.toMatchObject({ code: 'ELOOP' });
  });
});

describe('hostInfo', () => {
  it('throws when the free disk of the workspace cannot be read', async () => {
    const { ws } = paths();
    const ctx = context(ws, ws.env);
    expect((await hostInfo(ctx, null)).freeDiskBytes).toBeGreaterThan(0);
    const gone = { workspace: () => Promise.resolve({ root: join(ws.root, 'gone') }) } as unknown as Context;
    await expect(hostInfo(gone, null)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
