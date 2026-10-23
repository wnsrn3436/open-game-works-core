import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedKindsAt } from '../../../../src/commands/build/lib/saveschema.ts';

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'ogw-saveschema-'));
  const g = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(join(root, 'README'), 'x');
  g('add', '-A');
  g('commit', '-qm', 'no contract');
  return root;
}

describe('changedKindsAt', () => {
  it('reads a PROD commit without contract/ as no contract, and fails on a commit git cannot read', async () => {
    const root = repo();
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(await changedKindsAt(root, head)).toEqual([]);
    await expect(changedKindsAt(root, '0000000000000000000000000000000000000000')).rejects.toThrow();
    // a contract folder that cannot be read is not an empty one
    mkdirSync(join(root, 'contract'));
    writeFileSync(join(root, 'contract', 'a.proto'), 'syntax = "proto3";\n');
    const { chmodSync } = await import('node:fs');
    chmodSync(join(root, 'contract', 'a.proto'), 0o000);
    await expect(changedKindsAt(root, head)).rejects.toThrow();
    chmodSync(join(root, 'contract', 'a.proto'), 0o644);
  });
});
