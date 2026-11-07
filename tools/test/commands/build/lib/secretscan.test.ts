import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanArtifacts, scanReadBudget } from '../../../../src/commands/build/lib/secretscan.ts';

/** The reads of artifact files: how many run at a time, and the most that ran together. */
const reads = vi.hoisted(() => ({ running: 0, most: 0 }));

vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return {
    ...real,
    // each read takes 30 ms: a read started beside it starts in that time
    readFile: async (...args: Parameters<typeof real.readFile>) => {
      reads.running += 1;
      reads.most = Math.max(reads.most, reads.running);
      try {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return await real.readFile(...args);
      } finally {
        reads.running -= 1;
      }
    },
  };
});

const saved = { ...scanReadBudget };

afterEach(() => {
  Object.assign(scanReadBudget, saved);
  reads.running = 0;
  reads.most = 0;
});

/** `builds/dev-1.0.0/<platform>/` with five 10-byte files, the second and the fifth holding the needle. */
function artifacts(): { root: string; dirs: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'ogw-scan-'));
  const dirs = ['android', 'web'].map((p) => join(root, 'builds', 'dev-1.0.0', p));
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  const files: [string, string][] = [['android/a.bin', 'aaaaaaaaaa'], ['android/b.bin', 'bbSECRETbb'], ['web/c.bin', 'cccccccccc'], ['web/d.bin', 'dddddddddd'], ['web/e.bin', 'SECRETeeee']];
  for (const [path, text] of files) writeFileSync(join(root, 'builds', 'dev-1.0.0', path), text);
  return { root, dirs };
}

const list = [{ label: 'secret db', value: Buffer.from('SECRET') }];

describe('scanArtifacts', () => {
  it('reads the files ahead together as far as the byte budget holds, and reports the hits in file order', async () => {
    const { root, dirs } = artifacts();
    scanReadBudget.bytes = 25;
    expect(await scanArtifacts(root, dirs, list)).toEqual(['builds/dev-1.0.0/android/b.bin: secret db', 'builds/dev-1.0.0/web/e.bin: secret db']);
    // two files of 10 bytes fit in 25 bytes, a third does not
    expect(reads.most).toBe(2);
  });

  it('reads a file larger than the budget alone', async () => {
    const { root, dirs } = artifacts();
    scanReadBudget.bytes = 5;
    expect(await scanArtifacts(root, dirs, list)).toEqual(['builds/dev-1.0.0/android/b.bin: secret db', 'builds/dev-1.0.0/web/e.bin: secret db']);
    expect(reads.most).toBe(1);
  });
});
