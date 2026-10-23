import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { OgwError } from './errors.ts';
import { isNotFound } from './fsx.ts';
import { hostBootId, isAlive, pidNamespace } from './proc.ts';

const POLL_MS = 100;
/** An entry folder without a pid file older than this is left over from a crash. */
const NO_PID_STALE_MS = 10_000;

/**
 * Runs `fn` while holding a file lock. The lock is a folder at `lockPath` with the owner pid and its PID namespace
 * inside. A lock whose owner process is gone is taken over; a lock of another PID namespace is never taken over by pid.
 */
export async function withLock<T>(lockPath: string, fn: () => Promise<T>, timeoutMs = 10 * 60_000): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await takeFolder(lockPath)) break;
    if (await removeIfStale(lockPath)) continue;
    if (Date.now() >= deadline) throw new OgwError(`lock busy: ${lockPath}`);
    await sleep(POLL_MS);
  }
  try {
    return await fn();
  } finally {
    await releaseFolder(lockPath);
  }
}

/**
 * Lets go of the lock or slot folder `path` that this process took. It is moved aside before it is removed: an empty
 * folder at `path` would be taken by the next owner (`takeFolder`) while the removal still runs.
 */
export async function releaseFolder(path: string): Promise<void> {
  const done = `${path}.done-${randomBytes(6).toString('hex')}`;
  try {
    await rename(path, done);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  await rm(done, { recursive: true, force: true });
}

/**
 * Makes the lock or slot folder `path` with this process's owner file inside; returns false when it is taken. The
 * folder is made beside it and moved to `path` in one step, so a lock folder always has its owner file. An empty folder
 * at `path` is not a lock: a move replaces it, or, where a move does not replace a folder (Windows), it is removed and
 * taken on the next try.
 */
export async function takeFolder(path: string): Promise<boolean> {
  const fresh = `${path}.new-${randomBytes(6).toString('hex')}`;
  await mkdir(fresh);
  try {
    await writeFile(join(fresh, 'pid'), ownerText());
    for (let tries = 1; ; tries += 1) {
      try {
        await rename(fresh, path);
        return true;
      } catch (error) {
        if (await targetTaken(error, path)) {
          // removes only an empty folder: a lock folder has its owner file
          await rmdir(path).catch(() => undefined);
          return false;
        }
        // Windows: the owner let the lock go between the failed move and the check; the move is tried once more
        if (!refusedMove(error) || tries === 2) throw error;
      }
    }
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
}

/** Whether a `rename` failed as it does on Windows onto a folder that is there (`EPERM` or `EACCES`). */
function refusedMove(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === 'EPERM' || code === 'EACCES';
}

/**
 * Whether a `rename` onto `target` failed because a folder is there: a folder that is not empty (POSIX), or any folder
 * (Windows, where a move does not replace a folder and fails with `EPERM` or `EACCES`).
 */
async function targetTaken(error: unknown, target: string): Promise<boolean> {
  const code = (error as { code?: string }).code;
  if (code === 'ENOTEMPTY' || code === 'EEXIST') return true;
  return refusedMove(error) && (await stat(target).catch(() => null)) !== null;
}

/**
 * The owner file of a lock, slot or reader entry: this process's pid, its PID namespace, the host boot id, and a random
 * value that makes each owner file differ from every other.
 */
export function ownerText(): string {
  return `${String(process.pid)}\n${pidNamespace() ?? ''}\n${hostBootId() ?? ''}\n${randomBytes(6).toString('hex')}\n`;
}

/** Whether the owner lines (`ownerText`) name a process that is gone, or one of an earlier boot. */
function ownerGone([pidLine, nsLine, bootLine]: string[], ns: string | null, bootId: string | null): boolean {
  if (bootLine !== undefined && bootLine !== '' && bootId !== null && bootLine !== bootId) return true;
  const pid = Number.parseInt(pidLine ?? '', 10);
  // a lock written before namespaces were recorded has no second line
  if (nsLine !== undefined && nsLine !== (ns ?? '')) return false;
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && !isAlive(pid);
}

/**
 * Whether a lock was left by a process that is gone. `ns` is the PID namespace of the caller. A lock of an earlier boot
 * of the host is stale whatever its pid: after a reboot the pid may belong to another process.
 */
export async function isStale(lockPath: string, ns: string | null = pidNamespace(), bootId: string | null = hostBootId()): Promise<boolean> {
  try {
    return ownerGone((await readFile(join(lockPath, 'pid'), 'utf8')).split('\n'), ns, bootId);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    // The owner made the folder but has not written the pid yet, or crashed in between.
    const info = await stat(lockPath).catch(() => null);
    return info !== null && Date.now() - info.mtimeMs > NO_PID_STALE_MS;
  }
}

/**
 * Moves away a lock or slot folder (`takeFolder`) left by a process that is gone; returns whether it did. The owner may
 * let the lock go and end between the read of its owner file and the check of its pid, and another process take the
 * lock: the owner file is read again after the check. The folder is moved to `<lockPath>.stale-<hash of the owner
 * file>` and left there: once one waiter moved it, another waiter that judged the same owner finds that name taken and
 * cannot move the lock that a new owner took meanwhile.
 */
export async function removeIfStale(lockPath: string, ns: string | null = pidNamespace(), bootId: string | null = hostBootId()): Promise<boolean> {
  const owner = await readOwner(lockPath);
  if (owner === null || !ownerGone(owner.split('\n'), ns, bootId)) return false;
  if ((await readOwner(lockPath)) !== owner) return false;
  const stale = `${lockPath}.stale-${createHash('sha256').update(owner).digest('hex').slice(0, 16)}`;
  try {
    await rename(lockPath, stale);
    return true;
  } catch (error) {
    if (isNotFound(error) || (await targetTaken(error, stale))) return false;
    throw error;
  }
}

/** The owner file of a lock folder; `null` when there is no folder or no owner file. */
async function readOwner(lockPath: string): Promise<string | null> {
  try {
    return await readFile(join(lockPath, 'pid'), 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}
