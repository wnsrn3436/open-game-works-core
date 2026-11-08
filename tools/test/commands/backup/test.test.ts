import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RECOVERY } from '../../../src/commands/backup/test.ts';
import { setNet } from '../../../src/commands/env/lib/net.ts';
import { makeWorkspace, ogw, realToolsWithout, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeBin, gameSettings, setSecrets, setupGame } from '../build/helpers.ts';
import { fakeNet } from '../env/fakes.ts';

/**
 * A Docker that answers the commands of the test from FAKE_* variables: `docker cp -` keeps each tar it gets,
 * `docker cp <file>` keeps the file, and each `docker exec` script is matched by what it runs.
 */
const DOCKER = `case "$1" in
  version) [ -n "$FAKE_NO_DOCKER" ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }; echo "\${FAKE_PLATFORM-linux/amd64}";;
  create) echo ctr1;;
  cp) if [ "$2" = - ]; then n=$(ls "$FAKE_DIR" | grep -c '^cp-'); cat > "$FAKE_DIR/cp-$n.tar"; else cp "$2" "$FAKE_DIR/wal-g"; fi;;
  exec)
    for last; do :; done
    if [ -n "$FAKE_EXEC_DOCKER_FAIL" ]; then case "$last" in *"$FAKE_EXEC_DOCKER_FAIL"*) echo "Error response from daemon: No such container: ctr1" >&2; exit 125;; esac; fi
    case "$last" in
      *backup-list*) cat "$FAKE_DIR/list.json"; exit "\${FAKE_LIST_CODE-0}";;
      *wal-show*) cat "$FAKE_DIR/show.json";;
      *backup-fetch*) [ -n "$FAKE_FETCH_FAIL" ] && { echo "ERROR: no backups found" >&2; exit 1; }; exit 0;;
      *recovery.signal*) exit "\${FAKE_START_CODE-0}";;
      *pg_is_in_recovery*) n=$(cat "$FAKE_DIR/polls" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE_DIR/polls"
        [ -n "$FAKE_STOPPED" ] && { echo "psql: error: connection to server failed" >&2; exit 2; }
        [ "$n" -lt "\${FAKE_PSQL_FAILS-0}" ] && { echo "psql: error: the database system is starting up" >&2; exit 2; }
        if [ "$n" -lt "\${FAKE_RECOVERY_POLLS-1}" ]; then echo t; else echo f; fi;;
      *status*) exit "\${FAKE_STATUS_CODE-3}";;
      *tail*) echo "FATAL:  could not locate required checkpoint record";;
      *ROW_COUNT*) [ -n "$FAKE_QUERY_ERROR" ] && { echo 'ERROR:  relation "storage_schema" does not exist' >&2; exit 1; }; echo "\${FAKE_ROWS-1}";;
    esac;;
esac
exit 0`;

const WALG_URL = 'https://github.com/wal-g/wal-g/releases/download/v3.0.9/wal-g-pg-20.04-amd64';
const WALG_BYTES = Buffer.from('WALG-BINARY');
const WALG = { tools: { ...realToolsWithout('walg'), walg: { version: '3.0.9', downloads: [{ platform: 'linux-x64', url: WALG_URL, sha256: createHash('sha256').update(WALG_BYTES).digest('hex') }] } } };
const NOW = Date.now();
const LIST = [
  { backup_name: 'base_old', time: '', finish_time: new Date(NOW - 10 * 86_400_000).toISOString() },
  { backup_name: 'base_new', time: '', finish_time: new Date(NOW - 3_600_000).toISOString() },
];
const SHOW = [
  { id: 1, missing_segments: [], backups: [{ backup_name: 'base_old' }], status: 'OK' },
  { id: 2, missing_segments: [], backups: [{ backup_name: 'base_new' }], status: 'OK' },
];

beforeEach(() => {
  setNet(fakeNet({ [WALG_URL]: WALG_BYTES }));
  RECOVERY.intervalMs = 5;
  RECOVERY.limitMs = 2000;
});

afterEach(() => {
  setNet(null);
});

interface Setup {
  dir: string;
  fake: string;
  env: NodeJS.ProcessEnv;
}

function setup(ws: TestWorkspace, list: unknown = LIST, show: unknown = SHOW, settingsPatch: Record<string, unknown> = {}): Setup {
  const dir = setupGame(ws, 'g', settingsPatch);
  setSecrets(ws, { 'ogw/g/PROD/backupKey': 'BACKUP-SECRET-VALUE' });
  const bin = fakeBin(ws, { docker: DOCKER });
  writeFile(bin.bin, 'list.json', list);
  writeFile(bin.bin, 'show.json', show);
  return { dir, fake: bin.bin, env: { ...bin.env, FAKE_DIR: bin.bin } };
}

function writeFile(dir: string, name: string, value: unknown): void {
  // the fake programs print these files as WAL-G prints its JSON
  writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
}

async function backupTest(ws: TestWorkspace, s: Setup, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; result: Record<string, unknown>; log: string; file: Record<string, unknown> | null }> {
  const out = await ogw(ws, ['backup', 'test', 'g', 'PROD'], { env: { ...s.env, ...env } });
  expect(out.stderr).toBe('');
  const path = join(s.dir, 'builds', 'prod-backup-test.json');
  const log = existsSync(join(s.fake, 'calls.log')) ? readFileSync(join(s.fake, 'calls.log'), 'utf8') : '';
  return { code: out.code, result: JSON.parse(out.stdout) as Record<string, unknown>, log, file: existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : null };
}

describe('ogw backup test', () => {
  it('passes: lists, checks the WAL with wal-show, fetches, recovers and queries in a throwaway container', async () => {
    const ws = makeWorkspace(WALG);
    const s = setup(ws);
    const before = Date.now();
    const { code, result, log, file } = await backupTest(ws, s, { FAKE_RECOVERY_POLLS: '2' });
    expect(code).toBe(0);
    expect(result).toEqual({ started_at: expect.any(Number) as unknown, result: 'pass', reason: null, base_backup: 'base_new', base_backup_finished_at: Date.parse(LIST[1]?.finish_time as string) });
    expect(result.started_at as number).toBeGreaterThanOrEqual(before);
    expect(file).toEqual(result);
    const lines = log.trim().split('\n');
    const create = lines.find((l) => l.startsWith('docker create')) as string;
    expect(create).toContain('--entrypoint sleep --env WALG_S3_PREFIX=s3://backups/g/prod --env AWS_ENDPOINT=https://s3.example.com --env AWS_REGION=auto --env AWS_ACCESS_KEY_ID=AKID --env AWS_S3_FORCE_PATH_STYLE=true postgres:18.');
    expect(create).toMatch(/ infinity$/);
    expect(create).toContain('label=ogw.postgres=throwaway');
    expect(readFileSync(join(s.fake, 'wal-g'), 'utf8')).toBe('WALG-BINARY');
    const tars = readdirSync(s.fake).filter((f) => f.startsWith('cp-')).sort().map((f) => readFileSync(join(s.fake, f), 'latin1'));
    // the password file of the container, the secret file, then the restore_command script
    expect(tars[1]).toContain('run/secrets/backupKey');
    expect(tars[1]).toContain('BACKUP-SECRET-VALUE');
    expect(tars[2]).toContain('ogw-wal-fetch');
    expect(tars[2]).toContain('AWS_SECRET_ACCESS_KEY="$(cat \'/run/secrets/backupKey\')" exec wal-g wal-fetch "$1" "$2"');
    const execs = lines.filter((l) => l.startsWith('docker exec -u postgres ctr1 sh -c '));
    const key = `AWS_SECRET_ACCESS_KEY="$(cat '/run/secrets/backupKey')"`;
    expect(execs.map((l) => l.slice('docker exec -u postgres ctr1 sh -c '.length))).toEqual([
      `${key} wal-g backup-list --detail --json`,
      `${key} wal-g wal-show --detailed-json`,
      `${key} wal-g backup-fetch "$PGDATA" LATEST`,
      `touch "$PGDATA/recovery.signal" && chmod 0700 "$PGDATA" && pg_ctl -D "$PGDATA" -l /tmp/ogw-recovery.log -w -t 2 -o "-c listen_addresses='' -c archive_mode=off -c restore_command='sh /ogw-wal-fetch %f %p'" start`,
      "psql -X -At -c 'SELECT pg_is_in_recovery()'",
      "psql -X -At -c 'SELECT pg_is_in_recovery()'",
      "psql -X -At -c 'SELECT pg_is_in_recovery()'",
      "psql -X -At -v ON_ERROR_STOP=1 -o /dev/null -c 'SELECT definition FROM storage_schema WHERE name = '\\''base'\\''' -c '\\echo :ROW_COUNT'",
    ]);
    expect(lines.at(-1)).toBe('docker rm --force --volumes ctr1');
    expect(log).not.toContain('BACKUP-SECRET-VALUE');
  });

  it('fails the WAL check, or the age of the newest base backup, before it fetches, and removes the container', async () => {
    const gap = [{ id: 1, missing_segments: ['000000010000000000000005'], backups: [{ backup_name: 'base_old' }] }, SHOW[1]];
    const ws = makeWorkspace(WALG);
    const missing = await backupTest(ws, setup(ws, LIST, gap));
    expect(missing).toMatchObject({ code: 1, result: { result: 'fail', reason: 'WAL check: timeline 1 misses 000000010000000000000005', base_backup: 'base_new' } });
    expect(missing.log).not.toContain('backup-fetch');
    expect(missing.log.trim().split('\n').at(-1)).toBe('docker rm --force --volumes ctr1');

    const ws2 = makeWorkspace(WALG);
    // baseBackupIntervalMs is 1 h by the PROD backup settings below: the newest finished 1 h ago, not less than 2 h
    const old = [LIST[0], { backup_name: 'base_new', finish_time: new Date(NOW - 7_200_000 - 60_000).toISOString() }];
    const stale = await backupTest(ws2, setup(ws2, old, SHOW, { environments: withBackup({ baseBackupIntervalMs: 3_600_000 }) }));
    expect(stale.result.result).toBe('fail');
    expect(stale.result.reason).toMatch(/^the newest base backup base_new finished \d+ ms before the test started, not less than twice baseBackupIntervalMs \(7200000 ms\)$/);
    expect(stale.log).not.toContain('backup-fetch');
  });

  it('fails when PostgreSQL does not start, stops during recovery, or the query does not return one row', async () => {
    const run = async (env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> => {
      const ws = makeWorkspace(WALG);
      const { result, log } = await backupTest(ws, setup(ws), env);
      expect(log.trim().split('\n').at(-1)).toBe('docker rm --force --volumes ctr1');
      return result;
    };
    expect(await run({ FAKE_START_CODE: '1' })).toMatchObject({ result: 'fail', reason: 'PostgreSQL did not start on the fetched data folder: FATAL:  could not locate required checkpoint record' });
    expect(await run({ FAKE_STOPPED: '1' })).toMatchObject({ result: 'fail', reason: 'PostgreSQL stopped during recovery: FATAL:  could not locate required checkpoint record' });
    expect(await run({ FAKE_ROWS: '0' })).toMatchObject({ result: 'fail', reason: "SELECT definition FROM storage_schema WHERE name = 'base' returned 0 rows, not 1" });
    expect(await run({ FAKE_QUERY_ERROR: '1' })).toMatchObject({ result: 'fail', reason: `SELECT definition FROM storage_schema WHERE name = 'base' failed: ERROR:  relation "storage_schema" does not exist` });
  });

  it('is unknown when a Docker or WAL-G command fails before its condition, or recovery reaches its time limit', async () => {
    const run = async (env: NodeJS.ProcessEnv, list: unknown = LIST): Promise<{ result: Record<string, unknown>; log: string }> => {
      const ws = makeWorkspace(WALG);
      const { code, result, log } = await backupTest(ws, setup(ws, list), env);
      expect(code).toBe(1);
      return { result, log };
    };
    const docker = await run({ FAKE_NO_DOCKER: '1' });
    expect(docker.result).toMatchObject({ result: 'unknown', reason: 'docker version failed: Cannot connect to the Docker daemon', base_backup: null });
    expect(docker.log).not.toContain('docker create');
    expect((await run({ FAKE_LIST_CODE: '1' })).result).toMatchObject({ result: 'unknown', reason: expect.stringMatching(/^wal-g backup-list --detail --json failed: /) as unknown });
    expect((await run({}, 'ERROR: 403 Forbidden')).result).toMatchObject({ result: 'unknown', reason: expect.stringMatching(/^wal-g backup-list --detail --json printed no JSON \(.*\): ERROR: 403 Forbidden$/) as unknown });
    expect((await run({}, [{ name: 'x' }])).result).toMatchObject({ result: 'unknown', reason: 'wal-g backup-list --detail --json printed no list of base backups: [{"name":"x"}]' });
    expect((await run({ FAKE_FETCH_FAIL: '1' })).result).toMatchObject({ result: 'unknown', reason: 'wal-g backup-fetch failed: ERROR: no backups found', base_backup: 'base_new' });
    const slow = await run({ FAKE_RECOVERY_POLLS: '1000000' });
    expect(slow.result).toMatchObject({ result: 'unknown', reason: 'recovery did not end within 2000 ms' });
    expect(slow.log.trim().split('\n').at(-1)).toBe('docker rm --force --volumes ctr1');
  });

  it('waits while psql fails and PostgreSQL still runs: passes when recovery ends, unknown at the time limit', async () => {
    const ws = makeWorkspace(WALG);
    const s = setup(ws);
    // psql fails twice while pg_ctl status says PostgreSQL runs, then recovery has ended
    const waited = await backupTest(ws, s, { FAKE_PSQL_FAILS: '2', FAKE_RECOVERY_POLLS: '2', FAKE_STATUS_CODE: '0' });
    expect(waited).toMatchObject({ code: 0, result: { result: 'pass', reason: null } });
    const lines = waited.log.trim().split('\n');
    expect(lines.filter((l) => l.endsWith("psql -X -At -c 'SELECT pg_is_in_recovery()'"))).toHaveLength(3);
    expect(lines.filter((l) => l.endsWith('pg_ctl -D "$PGDATA" status'))).toHaveLength(2);

    const ws2 = makeWorkspace(WALG);
    const never = await backupTest(ws2, setup(ws2), { FAKE_PSQL_FAILS: '1000000', FAKE_STATUS_CODE: '0' });
    expect(never).toMatchObject({ code: 1, result: { result: 'unknown', reason: 'recovery did not end within 2000 ms' } });
    expect(never.file).toEqual(never.result);
  });

  it('is unknown when docker exec itself fails in the start of PostgreSQL, the wait or the query', async () => {
    for (const step of ['recovery.signal', 'pg_is_in_recovery', 'ROW_COUNT']) {
      const ws = makeWorkspace(WALG);
      const { code, result, file, log } = await backupTest(ws, setup(ws), { FAKE_EXEC_DOCKER_FAIL: step });
      expect(code).toBe(1);
      expect(result).toMatchObject({ result: 'unknown', reason: 'docker exec failed: Error response from daemon: No such container: ctr1', base_backup: 'base_new' });
      expect(file).toEqual(result);
      expect(log.trim().split('\n').at(-1)).toBe('docker rm --force --volumes ctr1');
    }
  });

  it('is unknown when the tools.walg binary cannot be fetched or differs from its pin', async () => {
    for (const [route, reason] of [
      [{}, `harness settings tools.walg linux-x64: download failed (404): ${WALG_URL}`],
      [{ [WALG_URL]: 'OTHER-BYTES' }, 'harness settings tools.walg linux-x64: SHA-256 differs from the pin'],
    ] as const) {
      setNet(fakeNet(route));
      const ws = makeWorkspace(WALG);
      const s = setup(ws);
      const { code, result, file, log } = await backupTest(ws, s);
      expect(code).toBe(1);
      expect(result).toMatchObject({ result: 'unknown', reason, base_backup: null });
      expect(file).toEqual(result);
      expect(log).not.toContain('docker create');
    }
  });

  it('is unknown without backup, its secret or tools.walg, with another PostgreSQL major, or without a download for the platform of Docker', async () => {
    const environments = withBackup(null);
    const ws = makeWorkspace({ tools: realToolsWithout('walg') });
    const s = setup(ws, LIST, SHOW, { environments, postgresqlMajor: 17 });
    setSecrets(ws, {});
    const { code, result, log, file } = await backupTest(ws, s);
    expect(code).toBe(1);
    expect(result).toMatchObject({
      result: 'unknown',
      reason: expect.stringMatching(
        /^game settings environments\.PROD\.backup is missing; secret backupKey of PROD is not in the secret store; harness settings tools\.walg is missing; harness settings tools\.postgresql tag major \d+ differs from game settings postgresqlMajor 17$/,
      ) as unknown,
      base_backup: null,
      base_backup_finished_at: null,
    });
    expect(file).toEqual(result);
    expect(log).toBe('');

    const ws2 = makeWorkspace(WALG);
    const arm = await backupTest(ws2, setup(ws2), { FAKE_PLATFORM: 'linux/arm64' });
    expect(arm.result).toMatchObject({ result: 'unknown', reason: "harness settings tools.walg has no download for the platform linux/arm64 of this host's Docker" });
    expect(arm.log).not.toContain('docker create');
  });
});

/** The game settings environments with PROD `backup` changed by `patch`, or without it for null. */
function withBackup(patch: Record<string, unknown> | null): Record<string, unknown> {
  const environments = gameSettings().environments as Record<string, Record<string, unknown>>;
  const prod = environments.PROD as Record<string, unknown>;
  if (patch === null) delete prod.backup;
  else prod.backup = { ...(prod.backup as Record<string, unknown>), ...patch };
  return environments;
}
