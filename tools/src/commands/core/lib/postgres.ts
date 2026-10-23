import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { removeContainer, startPostgresContainer } from '../../../lib/docker-postgres.ts';
import { run, runOk } from '../../../lib/proc.ts';

/** A throwaway PostgreSQL container of harness settings `tools.postgresql`. */
export interface PostgresContainer {
  id: string;
  /** Creates a new database and returns its connection string. */
  createDatabase(name: string): Promise<string>;
  remove(): Promise<void>;
}

const READY_WAIT_MS = 120_000;
const READY_POLL_MS = 500;

export async function startPostgres(ctx: Context, image: { tag: string; digest: string }): Promise<PostgresContainer> {
  const password = randomBytes(18).toString('base64url');
  const id = await startPostgresContainer({
    // tests open a connection pool per test file: room for the files of a whole `ogw core test server` run at once
    // (three runs at once peaked at 177 client backends); a test server start takes about 730 relation locks in its one
    // schema transaction. The container is thrown away after the run, so its data is never kept: without fsync and full
    // page writes, a `DROP DATABASE` no longer waits on a cluster checkpoint that fsyncs the files of every database the
    // other test servers made (measured 17–60 s per drop with them, under 1 s without)
    options: ['--rm', '--publish', '127.0.0.1::5432', '--shm-size', '1g'],
    image: `postgres:${image.tag}@${image.digest}`,
    command: ['-c', 'max_connections=1000', '-c', 'max_locks_per_transaction=256', '-c', 'fsync=off', '-c', 'full_page_writes=off'],
    password,
    env: ctx.env,
  });
  const remove = (): Promise<void> => removeContainer(id, ctx.env);
  try {
    const deadline = Date.now() + READY_WAIT_MS;
    for (;;) {
      const ready = await run('docker', ['exec', id, 'pg_isready', '--username', 'postgres', '--host', '127.0.0.1'], { env: ctx.env, timeoutMs: LIMITS.shortMs });
      if (ready.code === 0) break;
      if (Date.now() >= deadline) throw new OgwError('PostgreSQL container did not become ready');
      await sleep(READY_POLL_MS);
    }
    const port = (await runOk('docker', ['port', id, '5432/tcp'], { env: ctx.env, timeoutMs: LIMITS.shortMs })).stdout.trim().split('\n')[0] ?? '';
    const address = /:(\d+)$/.exec(port)?.[1];
    if (address === undefined) throw new OgwError(`cannot read the PostgreSQL port: ${port}`);
    return {
      id,
      async createDatabase(name) {
        await runOk('docker', ['exec', id, 'createdb', '--username', 'postgres', name], { env: ctx.env, timeoutMs: LIMITS.shortMs });
        return `postgresql://postgres:${password}@127.0.0.1:${address}/${name}`;
      },
      remove,
    };
  } catch (error) {
    await remove();
    throw error;
  }
}
