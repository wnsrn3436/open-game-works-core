import { mkdtempSync, mkdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ignoreCleanupError } from '../../src/lib/errors.ts';
import { whenNotFound } from '../../src/lib/fsx.ts';

describe('whenNotFound', () => {
  it('turns a missing file into the value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-nf-'));
    expect(await readFile(join(dir, 'absent'), 'utf8').catch(whenNotFound(null))).toBeNull();
  });

  it('rethrows every other error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-nf-'));
    mkdirSync(join(dir, 'folder'));
    await expect(readFile(join(dir, 'folder'), 'utf8').catch(whenNotFound(null))).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(Promise.reject(new SyntaxError('bad')).catch(whenNotFound(null))).rejects.toThrow('bad');
  });
});

describe('ignoreCleanupError', () => {
  it('drops the failure of a cleanup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-nf-'));
    await expect(rm(join(dir, 'absent')).catch(ignoreCleanupError)).resolves.toBeUndefined();
  });
});
