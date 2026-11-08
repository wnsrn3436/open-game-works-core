import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupScript, composeYaml } from '../../../src/commands/deploy/lib/compose.ts';
import { nextDeployList, type PatchEntry } from '../../../src/commands/deploy/lib/deploylist.ts';
import { shellQuote } from '../../../src/commands/deploy/lib/ssh.ts';

const entry = (data_version: string, bundle = ''): PatchEntry => ({
  data_version,
  data_files: [{ name: `${data_version}.bin`, size: 1, sha256: 'a' }],
  translation_files: [],
  bundle_files: bundle ? [{ bundle, name: `${bundle}.pck`, size: 1, sha256: 'b' }] : [],
});

describe('composeYaml', () => {
  it('writes the db and server services', () => {
    const yaml = composeYaml({
      game: 'g', env: 'dev', envArg: 'DEV', dir: '/srv/g', port: 8081,
      postgres: { tag: '18.6', digest: 'sha256:d' }, serverImage: 'ghcr.io/x/s:dev-1.0.0', matchmaker: true,
      dbPasswordSecret: 'dbPassword', serverSecrets: ['db', 'adminOgw', 'atk'], log: { maxBytes: 1048576, maxFiles: 3 }, backup: null,
    });
    expect(yaml).toBe(`name: "g-dev"
services:
  db:
    image: "postgres:18.6@sha256:d"
    environment:
      POSTGRES_PASSWORD_FILE: "/run/secrets/dbPassword"
    secrets:
      - "dbPassword"
    volumes:
      - "db-data:/var/lib/postgresql"
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: "2s"
      timeout: "5s"
      retries: 30
    logging:
      driver: "json-file"
      options:
        max-size: "1048576"
        max-file: "3"
  server:
    image: "ghcr.io/x/s:dev-1.0.0"
    command: ["--env", "DEV", "--matchmaker"]
    ports:
      - "127.0.0.1:8081:8080"
      - "127.0.0.1:8082:9464"
    secrets:
      - "adminOgw"
      - "atk"
      - "db"
    depends_on:
      db:
        condition: "service_healthy"
    restart: "unless-stopped"
    logging:
      driver: "json-file"
      options:
        max-size: "1048576"
        max-file: "3"
volumes:
  db-data: {}
secrets:
  "adminOgw":
    file: "/srv/g/secrets/adminOgw"
  "atk":
    file: "/srv/g/secrets/atk"
  "db":
    file: "/srv/g/secrets/db"
  "dbPassword":
    file: "/srv/g/secrets/dbPassword"
`);
  });

  it('mounts the data folder of older majors and leaves out --matchmaker', () => {
    const yaml = composeYaml({
      game: 'g', env: 'stg', envArg: 'STG', dir: '/d', port: 9000, postgres: { tag: '17.2', digest: 'sha256:e' },
      serverImage: 'i', matchmaker: false, dbPasswordSecret: 'p', serverSecrets: [], log: { maxBytes: 2, maxFiles: 1 }, backup: null,
    });
    expect(yaml).toContain('"db-data:/var/lib/postgresql/data"');
    expect(yaml).toContain('command: ["--env", "STG"]');
  });

  it('with backup: archives WAL in db, adds the backup service, and keeps the backup secret from the server', () => {
    const yaml = composeYaml({
      game: 'g', env: 'dev', envArg: 'DEV', dir: '/srv/g', port: 8080, postgres: { tag: '17.2', digest: 'sha256:e' },
      serverImage: 'i', matchmaker: false, dbPasswordSecret: 'dbPassword', serverSecrets: ['atk'], log: { maxBytes: 2, maxFiles: 1 }, backup: BACKUP,
    });
    const walg = [
      '      WALG_S3_PREFIX: "s3://bk/g/dev"',
      '      AWS_ENDPOINT: "https://s3.example.com"',
      '      AWS_REGION: "auto"',
      '      AWS_ACCESS_KEY_ID: "AKID"',
      '      AWS_S3_FORCE_PATH_STYLE: "true"',
    ].join('\n');
    const binary = '      - type: "bind"\n        source: "/srv/g/bin/wal-g"\n        target: "/usr/local/bin/wal-g"\n        read_only: true\n';
    const db = yaml.slice(yaml.indexOf('  db:\n'), yaml.indexOf('  backup:\n'));
    // Compose reads `$` as interpolation: the shell gets `$(cat ...)` through `$$`
    expect(db).toContain(
      `    command: ["postgres", "-c", "archive_mode=on", "-c", "archive_timeout=61", "-c", "archive_command=AWS_SECRET_ACCESS_KEY=\\"$$(cat '/run/secrets/backupKey')\\" wal-g wal-push %p"]\n`,
    );
    expect(db).toContain(`      POSTGRES_PASSWORD_FILE: "/run/secrets/dbPassword"\n${walg}\n    secrets:\n      - "backupKey"\n      - "dbPassword"\n`);
    expect(db).toContain(`      - "db-data:/var/lib/postgresql/data"\n${binary}`);
    const backup = yaml.slice(yaml.indexOf('  backup:\n'), yaml.indexOf('  server:\n'));
    expect(backup).toContain('    image: "postgres:17.2@sha256:e"\n    entrypoint: ["/bin/sh", "-c", "set -eu\\n');
    expect(backup).toContain(`${walg}\n      PGHOST: "db"\n      PGUSER: "postgres"\n    secrets:\n      - "backupKey"\n      - "dbPassword"\n`);
    expect(backup).toContain(`      - type: "volume"\n        source: "db-data"\n        target: "/var/lib/postgresql/data"\n        read_only: true\n${binary}`);
    expect(backup).toContain('    depends_on:\n      db:\n        condition: "service_healthy"\n    restart: "unless-stopped"\n    logging:');
    expect(backup).not.toMatch(/[^$]\$[^$]/);
    const server = yaml.slice(yaml.indexOf('  server:\n'), yaml.indexOf('volumes:\n  db-data'));
    expect(server).toContain('    ports:\n      - "127.0.0.1:8080:8080"\n      - "127.0.0.1:8081:9464"\n    secrets:\n      - "atk"\n    depends_on:');
    expect(yaml).toContain('  "backupKey":\n    file: "/srv/g/secrets/backupKey"\n');
  });
});

const BACKUP = {
  secret: 'backupKey', endpoint: 'https://s3.example.com', region: 'auto', bucket: 'bk', prefix: 'g/dev', accessKeyId: 'AKID',
  walSwitchMs: 61_900, baseBackupIntervalMs: 3_600_000, retentionMs: 86_400_000,
};

describe('backupScript', () => {
  /**
   * Runs one round of the loop with fake programs: `psql` answers the newest finish time to the first query and the
   * base backup to delete to the second, `date +%s` is 10000 s, and `sleep` ends the loop.
   */
  function round(newest: string, old: string): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-backup-script-'));
    const log = join(dir, 'calls.log');
    const scripts: Record<string, string> = {
      'wal-g': `echo "wal-g $* key=$AWS_SECRET_ACCESS_KEY" >> ${shellQuote(log)}\n[ "$1" = backup-list ] && echo '[{"backup_name":"b1"}]'\nexit 0`,
      psql: `sql=$(cat)\necho "psql $* pw=$PGPASSWORD" >> ${shellQuote(log)}\ncase "$sql" in *coalesce*) echo ${shellQuote(newest)};; *) echo ${shellQuote(old)};; esac`,
      date: 'echo 10000',
      sleep: 'exit 1',
      cat: `case "$1" in /run/secrets/backupKey) printf 'K\\n';; /run/secrets/dbPassword) printf 'P\\n';; *) exec /bin/cat "$@";; esac`,
    };
    for (const [name, body] of Object.entries(scripts)) writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const result = spawnSync('/bin/sh', ['-c', backupScript(BACKUP, 'dbPassword')], { env: { PATH: `${dir}:/usr/bin:/bin`, PGDATA: '/data' }, encoding: 'utf8' });
    expect(result.status).toBe(1);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    rmSync(dir, { recursive: true, force: true });
    return calls;
  }

  it('pushes a base backup when there is none and deletes before the newest one past retention', () => {
    expect(round('-1', 'b0')).toEqual([
      'wal-g backup-list --json key=K',
      'psql -X -At -v ON_ERROR_STOP=1 -v list=[{"backup_name":"b1"}] pw=P',
      'wal-g backup-push /data key=K',
      'wal-g backup-list --json key=K',
      'psql -X -At -v ON_ERROR_STOP=1 -v list=[{"backup_name":"b1"}] pw=P',
      'wal-g delete before FIND_FULL b0 --confirm key=K',
    ]);
  });

  it('pushes when the newest finished baseBackupIntervalMs or more ago, and deletes nothing within retention', () => {
    // now is 10 000 000 ms: 6 400 000 is exactly baseBackupIntervalMs ago, 6 400 001 is less
    expect(round('6400000', '').map((c) => c.split(' ')[1])).toEqual(['backup-list', '-X', 'backup-push', 'backup-list', '-X']);
    expect(round('6400001', 'b0').map((c) => c.split(' ')[1])).toEqual(['backup-list', '-X']);
  });

  it('asks psql for the newest finish time and the newest base backup past retention', () => {
    const script = backupScript(BACKUP, 'dbPassword');
    expect(script).toContain("SELECT coalesce(max(extract(epoch FROM (b->>'time')::timestamptz) * 1000)::bigint, -1) FROM json_array_elements(:'list'::json) b");
    expect(script).toContain("SELECT b->>'backup_name' FROM json_array_elements(:'list'::json) b WHERE extract(epoch FROM (b->>'time')::timestamptz) * 1000 < $now - 86400000 ORDER BY");
  });
});

describe('nextDeployList', () => {
  const update = { data_version: 'new', data_files: [], translation_files: [], apps: ['1.0.0', '1.1.0', '0.9.0'] };
  const app = { android: { min_version: '1.0.0', recommended_version: '1.1.0', store_url: 'https://s' }, ios: { min_version: '1.1.0', recommended_version: '1.1.0', store_url: 'https://s' } };

  it('takes update apps at or above the lowest min_version, keeps compat entries, drops the rest', () => {
    const read = { app, patches: { '1.0.0': entry('old', 'b1'), '0.8.0': entry('compat'), '0.7.0': entry('gone') } };
    expect(nextDeployList({ read, dbWiped: false, update, patch: null, compat: 'compat' })).toEqual({
      app,
      patches: {
        '1.0.0': { data_version: 'new', data_files: [], translation_files: [], bundle_files: entry('old', 'b1').bundle_files },
        '1.1.0': { data_version: 'new', data_files: [], translation_files: [], bundle_files: [] },
        '0.8.0': entry('compat'),
      },
    });
  });

  it('takes every update app when app is empty, and counts read patches empty after a DB wipe', () => {
    const read = { app: {}, patches: { '0.8.0': entry('compat') } };
    const next = nextDeployList({ read, dbWiped: true, update, patch: null, compat: 'compat' });
    expect(Object.keys(next.patches)).toEqual(['1.0.0', '1.1.0', '0.9.0']);
    expect(next.app).toEqual({});
    expect(nextDeployList({ read: null, dbWiped: false, update: null, patch: null, compat: '' })).toEqual({ app: {}, patches: {} });
  });

  it('keeps every read entry when the server stays (no server image)', () => {
    const read = { app, patches: { '1.0.0': entry('old'), '1.1.0': entry('other'), '0.7.0': entry('older') } };
    const next = nextDeployList({ read, dbWiped: false, update: null, patch: { appVersion: '1.1.0', entry: entry('p', 'patch_1') }, compat: null });
    expect(next.patches).toEqual({ '1.0.0': entry('old'), '1.1.0': entry('p', 'patch_1'), '0.7.0': entry('older') });
  });

  it('puts patch.json over the same app version', () => {
    const next = nextDeployList({ read: { app, patches: {} }, dbWiped: false, update, patch: { appVersion: '1.0.0', entry: entry('p', 'patch_1') }, compat: '' });
    expect(next.patches['1.0.0']).toEqual(entry('p', 'patch_1'));
  });
});

describe('shellQuote', () => {
  it('quotes single quotes', () => {
    expect(shellQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
  });
});
