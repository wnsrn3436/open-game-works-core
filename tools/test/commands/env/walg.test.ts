import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setNet } from '../../../src/commands/env/lib/net.ts';
import { walgPlatform, walgProgram } from '../../../src/commands/env/lib/walg.ts';
import { makeWorkspace, realToolsWithout } from '../../helpers/workspace.ts';
import { ctxOf } from '../generate/helpers.ts';
import { fakeNet } from './fakes.ts';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const BASE = 'https://github.com/wal-g/wal-g/releases/download/v3.0.9';

/** A `.tar.gz` holding one file, as the WAL-G releases do. */
function tarGz(name: string, content: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'ogw-walg-tar-'));
  writeFileSync(join(dir, name), content);
  execFileSync('tar', ['-czf', join(dir, 'out.tar.gz'), '-C', dir, name]);
  return readFileSync(join(dir, 'out.tar.gz'));
}

function workspace(downloads: { platform: string; url: string; sha256: string }[] | null) {
  return makeWorkspace({ tools: { ...realToolsWithout('walg'), ...(downloads === null ? {} : { walg: { version: '3.0.9', downloads } }) } });
}

afterEach(() => {
  setNet(null);
});

describe('walgProgram', () => {
  it('maps the Docker platforms of serverImage.platform and of a Docker server', () => {
    expect(walgPlatform('linux/amd64')).toBe('linux-x64');
    expect(walgPlatform('linux/arm64')).toBe('linux-arm64');
    expect(walgPlatform('windows/amd64')).toBeNull();
  });

  it('fetches the binary of the platform once, runnable, and the program of an archive', async () => {
    const binary = Buffer.from('WALG-X64');
    const archive = tarGz('wal-g-pg-22.04-amd64', 'WALG-IN-TAR');
    const net = fakeNet({ [`${BASE}/wal-g-pg-22.04-amd64`]: binary, [`${BASE}/wal-g-pg-22.04-amd64.tar.gz`]: archive });
    setNet(net);
    const plain = workspace([{ platform: 'linux-x64', url: `${BASE}/wal-g-pg-22.04-amd64`, sha256: sha256(binary) }]);
    const program = await walgProgram(ctxOf(plain), 'linux/amd64');
    expect(program).toBe(join(plain.root, '.ogw', 'tools', 'walg', '3.0.9', 'linux-x64', 'download', 'wal-g-pg-22.04-amd64'));
    expect(readFileSync(program, 'utf8')).toBe('WALG-X64');
    expect(statSync(program).mode & 0o777).toBe(0o755);
    expect(await walgProgram(ctxOf(plain), 'linux/amd64')).toBe(program);
    expect(net.calls).toEqual([`GET ${BASE}/wal-g-pg-22.04-amd64`]);

    const tarred = workspace([{ platform: 'linux-x64', url: `${BASE}/wal-g-pg-22.04-amd64.tar.gz`, sha256: sha256(archive) }]);
    const inTar = await walgProgram(ctxOf(tarred), 'linux/amd64');
    expect(inTar).toBe(join(tarred.root, '.ogw', 'tools', 'walg', '3.0.9', 'linux-x64', 'files', 'wal-g-pg-22.04-amd64'));
    expect(readFileSync(inTar, 'utf8')).toBe('WALG-IN-TAR');
  });

  it('fails without the pin, without a download of the platform, and on a SHA-256 that differs', async () => {
    setNet(fakeNet({ [`${BASE}/wal-g-pg-22.04-amd64`]: 'other bytes' }));
    await expect(walgProgram(ctxOf(workspace(null)), 'linux/amd64')).rejects.toThrow('harness settings tools.walg is missing');
    const pinned = workspace([{ platform: 'linux-x64', url: `${BASE}/wal-g-pg-22.04-amd64`, sha256: '0'.repeat(64) }]);
    await expect(walgProgram(ctxOf(pinned), 'linux/arm64')).rejects.toThrow('harness settings tools.walg has no linux-arm64 download');
    await expect(walgProgram(ctxOf(pinned), 'windows/amd64')).rejects.toThrow('tools.walg has no platform for Docker platform windows/amd64');
    await expect(walgProgram(ctxOf(pinned), 'linux/amd64')).rejects.toThrow('harness settings tools.walg linux-x64: SHA-256 differs from the pin');
  });
});
