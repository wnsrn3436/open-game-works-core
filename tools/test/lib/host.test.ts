import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentHost, resolveHostId } from '../../src/lib/host.ts';

/** An env whose PATH has only a folder with `name` printing `stdout`, without `OGW_HOST_ID`. */
function fakeProgram(name: string, stdout: string, code = 0): NodeJS.ProcessEnv {
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\nexit ${String(code)}\n`);
  chmodSync(file, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [bin, '/bin', '/usr/bin'].join(delimiter) };
  delete env.OGW_HOST_ID;
  return env;
}

describe('resolveHostId', () => {
  it('reads IOPlatformUUID on macOS', async () => {
    const env = fakeProgram('ioreg', '+-o J316sAP  <class IOPlatformExpertDevice>\n  {\n    "IOPlatformSerialNumber" = "X"\n    "IOPlatformUUID" = "1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809"\n  }');
    expect(await resolveHostId({ platform: 'darwin', env })).toBe('7ed649a359a0f853d4c804bc284fd11c');
  });

  it('fails on macOS when ioreg has no IOPlatformUUID or fails', async () => {
    await expect(resolveHostId({ platform: 'darwin', env: fakeProgram('ioreg', '{}') })).rejects.toThrow('ioreg has no IOPlatformUUID');
    await expect(resolveHostId({ platform: 'darwin', env: fakeProgram('ioreg', 'no', 1) })).rejects.toThrow('ioreg -rd1 -c IOPlatformExpertDevice failed');
  });

  it('reads /etc/machine-id on Linux', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'etc-'));
    const file = join(dir, 'machine-id');
    writeFileSync(file, '0f1e2d3c4b5a69788796a5b4c3d2e1f0\n');
    const env = fakeProgram('ioreg', 'unused');
    expect(await resolveHostId({ platform: 'linux', env, machineIdFile: file })).toBe('b57d9247f280f9f7a0473be997cc286a');
    await expect(resolveHostId({ platform: 'linux', env, machineIdFile: join(dir, 'missing') })).rejects.toThrow(`cannot read the host id: ${join(dir, 'missing')}`);
    writeFileSync(file, 'not-an-id\n');
    await expect(resolveHostId({ platform: 'linux', env, machineIdFile: file })).rejects.toThrow('gave "not-an-id"');
  });

  it('reads MachineGuid on Windows', async () => {
    const env = fakeProgram('reg', '\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\n    MachineGuid    REG_SZ    5b2c1a9e-77d4-4c2a-9f1e-0a1b2c3d4e5f\n');
    expect(await resolveHostId({ platform: 'win32', env })).toBe('ed508ba94be5e75e984df0663cfb3e62');
    await expect(resolveHostId({ platform: 'win32', env: fakeProgram('reg', 'nothing') })).rejects.toThrow('the registry has no MachineGuid');
  });

  it('fails on another OS and takes OGW_HOST_ID first', async () => {
    const env = fakeProgram('ioreg', 'unused');
    await expect(resolveHostId({ platform: 'freebsd', env })).rejects.toThrow('cannot read the host id on freebsd');
    expect(await resolveHostId({ platform: 'freebsd', env: { ...env, OGW_HOST_ID: 'ABCDEF01-2345-6789-ABCD-EF0123456789' } })).toBe('abcdef0123456789abcdef0123456789');
  });

  it('gives the host name next to the id', async () => {
    expect(await currentHost({ OGW_HOST_ID: 'ffffffffffffffffffffffffffffffff' })).toEqual({ id: 'ffffffffffffffffffffffffffffffff', name: hostname() });
  });
});
