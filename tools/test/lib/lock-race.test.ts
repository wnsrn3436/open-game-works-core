import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostBootId, pidNamespace } from '../../src/lib/proc.ts';

/** Runs once after the `nth` next read of the owner file at `path`. */
const afterRead = vi.hoisted(() => ({ path: '', nth: 1, then: (): void => undefined }));
/** `windows`: a rename onto a folder fails with `EPERM`, as on Windows. `beforeRm`: runs before each `rm`. */
const fsMode = vi.hoisted(() => ({ windows: false, beforeRm: null as ((path: string) => void) | null, onRefusal: null as ((to: string) => void) | null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      if (fsMode.windows && (await fs.stat(to).catch(() => null)) !== null) {
        fsMode.onRefusal?.(to);
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
      }
      return fs.rename(from, to);
    },
    rm: async (path: string, options?: Parameters<typeof fs.rm>[1]) => {
      fsMode.beforeRm?.(path);
      return fs.rm(path, options);
    },
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const text = await fs.readFile(...args);
      if (args[0] === afterRead.path) {
        afterRead.nth -= 1;
        if (afterRead.nth === 0) {
          afterRead.path = '';
          afterRead.then();
        }
      }
      return text;
    },
  };
});

const { removeIfStale, withLock } = await import('../../src/lib/lock.ts');

function ownerOf(pid: number): string {
  return `${String(pid)}\n${pidNamespace() ?? ''}\n${hostBootId() ?? ''}\n${String(Math.random())}\n`;
}

function goneProcess(): number {
  return Number(spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim());
}

describe('removeIfStale', () => {
  const live: ReturnType<typeof spawn>[] = [];
  afterEach(() => {
    afterRead.path = '';
    fsMode.windows = false;
    fsMode.beforeRm = null;
    for (const child of live.splice(0)) child.kill('SIGKILL');
  });

  function lockOf(owner: string): string {
    const lock = join(mkdtempSync(join(tmpdir(), 'ogw-lock-')), 'lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), owner);
    return lock;
  }

  function liveOwner(): string {
    const other = spawn('sleep', ['30'], { stdio: 'ignore' });
    live.push(other);
    return ownerOf(other.pid ?? 0);
  }

  /** After the `nth` read of the owner file of `lock`, runs `then`. */
  function onRead(lock: string, nth: number, then: () => void): void {
    afterRead.path = join(lock, 'pid');
    afterRead.nth = nth;
    afterRead.then = then;
  }

  it('keeps a lock that another process took after the read of the gone owner', async () => {
    const lock = lockOf(ownerOf(goneProcess()));
    const owner = liveOwner();
    // the gone owner let the lock go and another process took it before the pid was checked
    onRead(lock, 1, () => {
      writeFileSync(join(lock, 'pid'), owner);
    });
    expect(await removeIfStale(lock)).toBe(false);
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(owner);
  });

  it('keeps a lock that another waiter moved away and took after this one judged the same owner', async () => {
    const gone = ownerOf(goneProcess());
    const lock = lockOf(gone);
    const owner = liveOwner();
    // after both reads of this waiter, the other waiter moves the gone owner's lock away as removeIfStale does, and a new
    // owner takes the lock
    onRead(lock, 2, () => {
      renameSync(lock, `${lock}.stale-${createHash('sha256').update(gone).digest('hex').slice(0, 16)}`);
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), owner);
    });
    expect(await removeIfStale(lock)).toBe(false);
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(owner);
  });

  it('moves a lock whose owner is gone beside it, under a name of that owner', async () => {
    const gone = ownerOf(goneProcess());
    const lock = lockOf(gone);
    expect(await removeIfStale(lock)).toBe(true);
    expect(existsSync(lock)).toBe(false);
    const moved = readdirSync(dirname(lock)).filter((name) => name.startsWith('lock.stale-'));
    expect(moved).toHaveLength(1);
    expect(readFileSync(join(dirname(lock), moved[0] ?? '', 'pid'), 'utf8')).toBe(gone);
  });

  it('keeps the lock of a live owner', async () => {
    const owner = liveOwner();
    const lock = lockOf(owner);
    expect(await removeIfStale(lock)).toBe(false);
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(owner);
  });
});

describe('withLock', () => {
  it('takes a lock folder with its owner file in one step, and takes an empty folder', async () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'ogw-lock-')), 'lock');
    mkdirSync(lock);
    const seen = await withLock(lock, () => Promise.resolve(readFileSync(join(lock, 'pid'), 'utf8')));
    expect(seen.split('\n')[0]).toBe(String(process.pid));
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(dirname(lock))).toEqual([]);
  });

  it('waits for a lock whose owner is live', async () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'ogw-lock-')), 'lock');
    const other = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), ownerOf(other.pid ?? 0));
      await expect(withLock(lock, () => Promise.resolve('ran'), 300)).rejects.toThrow('lock busy');
      renameSync(lock, `${lock}-gone`);
      expect(await withLock(lock, () => Promise.resolve('ran'), 300)).toBe('ran');
    } finally {
      other.kill('SIGKILL');
    }
  });

  it('lets the lock go so that an owner that takes it during the removal keeps it', async () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'ogw-lock-')), 'lock');
    const next = join(dirname(lock), 'next');
    mkdirSync(next);
    writeFileSync(join(next, 'pid'), 'next owner');
    fsMode.beforeRm = (path) => {
      if ((path !== lock && !path.startsWith(`${lock}.done-`)) || !existsSync(next)) return;
      // a removal in place has removed the owner file before the folder; the next owner takes the folder then
      if (path === lock) unlinkSync(join(lock, 'pid'));
      renameSync(next, lock);
    };
    await withLock(lock, () => Promise.resolve());
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe('next owner');
  });
});

describe('locks where a move does not replace a folder (Windows)', () => {
  const live: ReturnType<typeof spawn>[] = [];
  afterEach(() => {
    fsMode.windows = false;
    fsMode.onRefusal = null;
    for (const child of live.splice(0)) child.kill('SIGKILL');
  });

  it('waits for a held lock, takes an empty folder, and leaves a stale lock that another waiter moved', async () => {
    fsMode.windows = true;
    const lock = join(mkdtempSync(join(tmpdir(), 'ogw-lock-')), 'lock');
    const other = spawn('sleep', ['30'], { stdio: 'ignore' });
    live.push(other);
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), ownerOf(other.pid ?? 0));
    await expect(withLock(lock, () => Promise.resolve('ran'), 300)).rejects.toThrow('lock busy');
    renameSync(lock, `${lock}-gone`);
    mkdirSync(lock);
    expect(await withLock(lock, () => Promise.resolve('ran'), 1000)).toBe('ran');

    const gone = ownerOf(goneProcess());
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), gone);
    // another waiter moved the same gone owner's lock away first, and a new owner took the lock
    mkdirSync(`${lock}.stale-${createHash('sha256').update(gone).digest('hex').slice(0, 16)}`);
    expect(await removeIfStale(lock)).toBe(false);
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(gone);
  });

  it('takes a lock that its owner let go between the refused move and the check', async () => {
    fsMode.windows = true;
    const lock = join(mkdtempSync(join(tmpdir(), 'ogw-lock-')), 'lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), liveOwnerText());
    fsMode.onRefusal = (to) => {
      fsMode.onRefusal = null;
      renameSync(to, `${to}.done-x`);
    };
    expect(await withLock(lock, () => Promise.resolve('ran'), 1000)).toBe('ran');
  });

  function liveOwnerText(): string {
    const other = spawn('sleep', ['30'], { stdio: 'ignore' });
    live.push(other);
    return ownerOf(other.pid ?? 0);
  }
});
