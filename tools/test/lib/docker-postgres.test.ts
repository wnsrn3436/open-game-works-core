import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { postgresDataPath, startPostgresContainer } from '../../src/lib/docker-postgres.ts';

let dir: string | null = null;

afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function createArgs(tag: string): Promise<string[][]> {
  dir = mkdtempSync(join(tmpdir(), 'ogw-docker-postgres-'));
  const log = join(dir, 'docker.log');
  writeFileSync(join(dir, 'docker'), `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = create ]; then echo cid1; fi\nif [ "$1" = cp ]; then cat > /dev/null; fi\nexit 0\n`);
  chmodSync(join(dir, 'docker'), 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` };
  await startPostgresContainer({ options: [], image: `postgres:${tag}@sha256:${'0'.repeat(64)}`, password: 'p', env });
  return readFileSync(log, 'utf8').split('\n').filter((l) => l !== '').map((l) => l.split(' '));
}

describe('startPostgresContainer', () => {
  it('puts the data on a labeled volume at the data VOLUME of the image major', async () => {
    for (const [tag, path] of [['18.6', '/var/lib/postgresql'], ['17.6', '/var/lib/postgresql/data']] as const) {
      const calls = await createArgs(tag);
      expect(calls[0]).toEqual(['volume', 'prune', '--force', '--filter', 'label=ogw.postgres=throwaway']);
      const create = calls[1] ?? [];
      expect(create[create.indexOf('--mount') + 1]).toBe(`type=volume,dst=${path},volume-label=ogw.postgres=throwaway`);
      expect(postgresDataPath(tag)).toBe(path);
      rmSync(dir ?? '', { recursive: true, force: true });
    }
  });
});
