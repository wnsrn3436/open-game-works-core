import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { OgwError } from '../../../lib/errors.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { removeContainer, startPostgresContainer } from '../../../lib/docker-postgres.ts';
import { run } from '../../../lib/proc.ts';
import { freePort } from './launch.ts';

export interface PostgresContainer {
  name: string;
  /** Connection string of the database `postgres` as user `postgres`. */
  url: string;
}

/** Name of the disposable PostgreSQL container of an instance. */
export function containerName(instanceId: string): string {
  return `ogw-instance-${instanceId}-db`;
}

/**
 * Starts a disposable PostgreSQL container from harness settings `tools.postgresql` and waits until it takes TCP
 * connections. The password is not in any process command line or environment variable: the container is created
 * with `POSTGRES_PASSWORD_FILE`, the file is copied in from stdin, then the container starts. When `stopping()`
 * becomes true, the container is removed and the start fails.
 */
export async function startPostgres(
  instanceId: string,
  image: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  stopping: () => boolean = () => false,
): Promise<PostgresContainer> {
  const name = containerName(instanceId);
  const password = randomBytes(24).toString('hex');
  const port = await freePort();
  const stopIfStopping = async (): Promise<void> => {
    if (!stopping()) return;
    await removePostgres(instanceId, env);
    throw new OgwError('the instance is stopping');
  };
  await startPostgresContainer({
    name,
    options: ['--publish', `127.0.0.1:${String(port)}:5432`],
    image,
    password,
    env,
    between: stopIfStopping,
  });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await stopIfStopping();
    const ready = await run('docker', ['exec', name, 'pg_isready', '--host', '127.0.0.1', '--username', 'postgres'], {
      timeoutMs: LIMITS.shortMs,
      env,
    });
    if (ready.code === 0) break;
    if (Date.now() >= deadline) {
      await removePostgres(instanceId, env);
      throw new OgwError(`PostgreSQL container ${name} did not get ready within ${String(timeoutMs)} ms`);
    }
    await sleep(500);
  }
  return { name, url: `postgresql://postgres:${password}@127.0.0.1:${String(port)}/postgres` };
}

/** Removes the container and its volumes. A missing container is not an error. */
export async function removePostgres(instanceId: string, env: NodeJS.ProcessEnv): Promise<void> {
  await removeContainer(containerName(instanceId), env);
}
