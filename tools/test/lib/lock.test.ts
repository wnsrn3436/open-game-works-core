import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isStale, ownerText } from '../../src/lib/lock.ts';
import { hostBootId, pidNamespace } from '../../src/lib/proc.ts';

function lockWith(owner: string): string {
  const lock = join(mkdtempSync(join(tmpdir(), 'ogw-lock-')), 'lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), owner);
  return lock;
}

describe('isStale', () => {
  it('takes a lock of an earlier boot as stale even when its pid is now another live process', async () => {
    const other = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      const pid = String(other.pid);
      const ns = pidNamespace() ?? '';
      expect(await isStale(lockWith(`${pid}\n${ns}\n${hostBootId() ?? ''}\n`))).toBe(false);
      expect(await isStale(lockWith(`${pid}\n${ns}\nan-earlier-boot\n`), pidNamespace(), 'this-boot')).toBe(true);
      // an owner file written before boot ids were recorded is judged by its pid
      expect(await isStale(lockWith(`${pid}\n${ns}\n`), pidNamespace(), 'this-boot')).toBe(false);
    } finally {
      other.kill('SIGKILL');
    }
  });

  it('writes the pid, the PID namespace and the boot id of this process, and a value that differs each time', () => {
    const [pid, ns, boot, nonce, end] = ownerText().split('\n');
    expect([pid, ns, boot, end]).toEqual([String(process.pid), pidNamespace() ?? '', hostBootId() ?? '', '']);
    expect(nonce).toMatch(/^[0-9a-f]{12}$/);
    expect(ownerText()).not.toBe(ownerText());
  });
});
