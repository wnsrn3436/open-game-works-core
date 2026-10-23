import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { secretCheck, secretNeedles } from '../../../../src/commands/code/lib/secret.ts';
import type { CheckTarget } from '../../../../src/commands/code/lib/target.ts';
import type { Context } from '../../../../src/lib/command.ts';
import { OgwError } from '../../../../src/lib/errors.ts';
import { needleHits } from '../../../../src/lib/secret-scan.ts';

const needles = [{ label: 'secret svcKey', value: Buffer.from('sk-very-secret-value') }];

describe('secretCheck', () => {
  it('searches every file whatever its size, as the build-time check does', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-secret-'));
    const big = Buffer.alloc(21 * 1024 * 1024, 'a');
    Buffer.from('\nsk-very-secret-value\n').copy(big, big.length - 30);
    writeFileSync(join(root, 'big.txt'), big);
    writeFileSync(join(root, 'bin.dat'), Buffer.concat([Buffer.from([0, 1]), Buffer.from('sk-very-secret-value')]));
    writeFileSync(join(root, 'clean.txt'), 'nothing\n');
    const target = { root, files: ['big.txt', 'bin.dat', 'clean.txt', 'gone.txt'] } as CheckTarget;
    expect(await secretCheck(target, needles)).toEqual(['big.txt:2: secret svcKey', 'bin.dat: secret svcKey']);
  });

  it('finds a value with line breaks, on the line it starts, as the build-time check does', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-secret-'));
    const pem = { label: 'secret pemKey', value: Buffer.from('-----BEGIN KEY-----\nabc\n-----END KEY-----') };
    writeFileSync(join(root, 'x.txt'), 'one\ntwo -----BEGIN KEY-----\nabc\n-----END KEY-----\nthree\n-----BEGIN KEY-----\nabc\n-----END KEY-----\n');
    writeFileSync(join(root, 'twice.txt'), 'sk-very-secret-value sk-very-secret-value\n\nsk-very-secret-value');
    writeFileSync(join(root, 'half.txt'), '-----BEGIN KEY-----\nabc\n');
    const target = { root, files: ['x.txt', 'twice.txt', 'half.txt'] } as CheckTarget;
    expect(await secretCheck(target, [...needles, pem])).toEqual([
      'x.txt:2: secret pemKey',
      'x.txt:6: secret pemKey',
      'twice.txt:1: secret svcKey',
      'twice.txt:3: secret svcKey',
    ]);
    const bytes = Buffer.from('a\n-----BEGIN KEY-----\nabc\n-----END KEY-----');
    expect(needleHits('f', bytes, [pem], false)).toEqual(['f: secret pemKey']);
    expect(needleHits('f', bytes, [pem], true)).toEqual(['f:2: secret pemKey']);
  });

  it('fails when the secret store cannot be read, and skips only a missing entry', async () => {
    const settings = {
      resourceGeneration: [
        { name: 'a', kind: 'external-service', resourceTypes: ['image'], safetyTimeoutMs: 1000, secret: 'svcKey' },
        { name: 'b', kind: 'external-service', resourceTypes: ['image'], safetyTimeoutMs: 1000, secret: 'other' },
      ],
    };
    const ctx = (get: (service: string) => string | null): Context =>
      ({ settings: () => Promise.resolve(settings), workspace: () => Promise.resolve({ root: '/ws' }), secrets: { get, set: () => undefined } }) as unknown as Context;
    const missing = await secretNeedles(ctx((service) => (service === 'ogw/harness/svcKey' ? 'v1' : null)));
    expect(missing.map((n) => n.label)).toEqual(['workspace path', 'secret svcKey']);
    const broken = ctx(() => {
      throw new OgwError('cannot read secret store: locked');
    });
    await expect(secretNeedles(broken)).rejects.toThrow('cannot read secret store: locked');
  });
});
