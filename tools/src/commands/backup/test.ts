import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { removeContainer, singleFileTar, startPostgresContainer } from '../../lib/docker-postgres.ts';
import { OgwError } from '../../lib/errors.ts';
import { formatJson, writeJsonAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { LIMITS } from '../../lib/limits.ts';
import { run, type RunResult } from '../../lib/proc.ts';
import { gameSecretService } from '../../lib/secrets.ts';
import { gameSettingsWithDefaults } from '../build/lib/buildrun.ts';
import { envLower, parseEnv, type Env } from '../build/lib/names.ts';
import { shellQuote } from '../deploy/lib/ssh.ts';
import { walgPlatform, walgProgram } from '../env/api.ts';
import { ageFailure, newestBackup, parseBackupList, parseWalShow, walCheckFailure, type BaseBackup } from './lib/judge.ts';

/** The wait for the end of recovery. Tests shorten it. */
export const RECOVERY = { intervalMs: 1000, limitMs: LIMITS.programMs };

export interface BackupTestResult {
  started_at: number;
  result: 'pass' | 'fail' | 'unknown';
  reason: string | null;
  base_backup: string | null;
  base_backup_finished_at: number | null;
}

/** A judged condition or a command that could not run: it ends the test with that result. */
class Verdict extends Error {
  readonly result: 'fail' | 'unknown';
  readonly reason: string;
  constructor(result: 'fail' | 'unknown', reason: string) {
    super(reason);
    this.result = result;
    this.reason = reason;
  }
}

interface BackupSettings {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  baseBackupIntervalMs: number;
}

interface Inputs {
  backup: BackupSettings;
  secretName: string;
  secretValue: string;
  image: string;
}

/** `builds/<env lowercase>-backup-test.json` of the game repo. */
export function backupTestPath(game: GameRepo, env: Env): string {
  return join(game.root, 'builds', `${envLower(env)}-backup-test.json`);
}

/** The settings and the secret the test reads; every one that is missing is a reason of `unknown`. */
async function readInputs(ctx: Context, game: GameRepo, env: Env): Promise<Inputs> {
  const settings = await gameSettingsWithDefaults(game.root, ctx.env);
  const envSettings = settings.environments?.[env] ?? {};
  const harness = await ctx.settings();
  const missing: string[] = [];
  const backup = envSettings.backup as BackupSettings | undefined;
  if (backup === undefined) missing.push(`game settings environments.${env}.backup is missing`);
  const secretName = (envSettings.secrets as Record<string, string> | undefined)?.backup;
  const secretValue = secretName === undefined ? null : ctx.secrets.get(gameSecretService(game.name, env, secretName));
  if (secretName === undefined) missing.push(`game settings environments.${env}.secrets.backup is missing`);
  else if (secretValue === null) missing.push(`secret ${secretName} of ${env} is not in the secret store`);
  if (harness.tools.walg === undefined) missing.push('harness settings tools.walg is missing');
  const pg = harness.tools.postgresql;
  const major = Number.parseInt(pg.tag, 10);
  if (major !== settings.postgresqlMajor) {
    missing.push(`harness settings tools.postgresql tag major ${String(major)} differs from game settings postgresqlMajor ${String(settings.postgresqlMajor)}`);
  }
  if (missing.length > 0 || backup === undefined || secretName === undefined || secretValue === null) throw new Verdict('unknown', missing.join('; '));
  return { backup, secretName, secretValue, image: `postgres:${pg.tag}@${pg.digest}` };
}

const output = (r: RunResult): string => (r.timedOut ? 'timed out' : (r.stderr.trim() || r.stdout.trim() || `exit code ${String(r.code)}`));

/** The WAL-G binary of `tools.walg` for the platform of this host's Docker; a missing download is `unknown`. */
async function walgForDocker(ctx: Context): Promise<string> {
  const version = await run('docker', ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'], { env: ctx.env, timeoutMs: LIMITS.shortMs });
  if (version.code !== 0) throw new Verdict('unknown', `docker version failed: ${output(version)}`);
  const platform = version.stdout.trim();
  const name = walgPlatform(platform);
  const downloads = (await ctx.settings()).tools.walg?.downloads ?? [];
  if (name === null || !downloads.some((d) => d.platform === name)) {
    throw new Verdict('unknown', `harness settings tools.walg has no download for the platform ${platform} of this host's Docker`);
  }
  return walgProgram(ctx, platform);
}

/** `AWS_SECRET_ACCESS_KEY` of a WAL-G command from the secret file, as in the containers of `ogw deploy`. */
function secretKey(secretName: string): string {
  return `AWS_SECRET_ACCESS_KEY="$(cat ${shellQuote(`/run/secrets/${secretName}`)})"`;
}

/** The `restore_command` script: `sh /ogw-wal-fetch %f %p`. */
const WAL_FETCH = '/ogw-wal-fetch';

class Container {
  readonly ctx: Context;
  readonly id: string;
  constructor(ctx: Context, id: string) {
    this.ctx = ctx;
    this.id = id;
  }

  docker(args: string[], input?: Buffer): Promise<RunResult> {
    return run('docker', args, { env: this.ctx.env, timeoutMs: LIMITS.programMs, ...(input === undefined ? {} : { input }) });
  }

  /** Runs a shell script as user `postgres`. */
  sh(script: string): Promise<RunResult> {
    return this.docker(['exec', '-u', 'postgres', this.id, 'sh', '-c', script]);
  }

  /** Runs a Docker or WAL-G command whose failure gives `unknown`; returns its stdout. */
  async must(label: string, script: string): Promise<string> {
    const result = await this.sh(script);
    if (result.code !== 0) throw new Verdict('unknown', `${label} failed: ${output(result)}`);
    return result.stdout;
  }

  async copy(args: string[], input?: Buffer): Promise<void> {
    const result = await this.docker(args, input);
    if (result.code !== 0) throw new Verdict('unknown', `docker ${args.slice(0, 1).join(' ')} failed: ${output(result)}`);
  }
}

/** The WAL-G settings of `ogw.md` `## deploy` as `docker create` options; the secret access key is a file. */
function walgOptions(backup: BackupSettings): string[] {
  const env = {
    WALG_S3_PREFIX: `s3://${backup.bucket}/${backup.prefix}`,
    AWS_ENDPOINT: backup.endpoint,
    AWS_REGION: backup.region,
    AWS_ACCESS_KEY_ID: backup.accessKeyId,
    AWS_S3_FORCE_PATH_STYLE: 'true',
  };
  return Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
}

async function startContainer(ctx: Context, inputs: Inputs, program: string): Promise<Container> {
  let id: string;
  try {
    // PostgreSQL does not start: the container only runs the commands of the test
    id = await startPostgresContainer({
      options: ['--entrypoint', 'sleep', ...walgOptions(inputs.backup)],
      image: inputs.image,
      command: ['infinity'],
      password: randomBytes(24).toString('hex'),
      env: ctx.env,
    });
  } catch (error) {
    if (error instanceof OgwError) throw new Verdict('unknown', `the throwaway PostgreSQL container did not start: ${error.message}`);
    throw error;
  }
  const container = new Container(ctx, id);
  try {
    await container.copy(['cp', program, `${id}:/usr/local/bin/wal-g`]);
    await container.copy(['cp', '-', `${id}:/`], singleFileTar(`run/secrets/${inputs.secretName}`, Buffer.from(inputs.secretValue)));
    const fetch = `${secretKey(inputs.secretName)} exec wal-g wal-fetch "$1" "$2"\n`;
    await container.copy(['cp', '-', `${id}:/`], singleFileTar(WAL_FETCH.slice(1), Buffer.from(fetch)));
  } catch (error) {
    await removeContainer(id, ctx.env);
    throw error;
  }
  return container;
}

const LOG = '/tmp/ogw-recovery.log';

async function logTail(c: Container): Promise<string> {
  const tail = await c.sh(`tail -n 20 ${LOG}`);
  return tail.code === 0 ? tail.stdout.trim() : `the log could not be read: ${output(tail)}`;
}

/** `docker exec` gives 125 to 127 when Docker, not the command, failed. */
const dockerFailed = (r: RunResult): boolean => r.code === null || r.code >= 125;

/** PostgreSQL on the fetched data folder with `recovery.signal`; waits until `pg_is_in_recovery()` is `false`. */
async function recover(c: Container): Promise<void> {
  const options = `-c listen_addresses='' -c archive_mode=off -c restore_command='sh ${WAL_FETCH} %f %p'`;
  const seconds = Math.ceil(RECOVERY.limitMs / 1000);
  const start = await c.sh(`touch "$PGDATA/recovery.signal" && chmod 0700 "$PGDATA" && pg_ctl -D "$PGDATA" -l ${LOG} -w -t ${String(seconds)} -o "${options}" start`);
  if (dockerFailed(start)) throw new Verdict('unknown', `docker exec failed: ${output(start)}`);
  if (start.code !== 0) throw new Verdict('fail', `PostgreSQL did not start on the fetched data folder: ${await logTail(c)}`);
  const deadline = Date.now() + RECOVERY.limitMs;
  for (;;) {
    const state = await c.sh("psql -X -At -c 'SELECT pg_is_in_recovery()'");
    if (state.code === 0 && state.stdout.trim() === 'f') return;
    if (dockerFailed(state)) throw new Verdict('unknown', `docker exec failed: ${output(state)}`);
    if (state.code !== 0 && (await c.sh('pg_ctl -D "$PGDATA" status')).code === 3) {
      throw new Verdict('fail', `PostgreSQL stopped during recovery: ${await logTail(c)}`);
    }
    if (Date.now() >= deadline) throw new Verdict('unknown', `recovery did not end within ${String(RECOVERY.limitMs)} ms`);
    await sleep(RECOVERY.intervalMs);
  }
}

const QUERY = "SELECT definition FROM storage_schema WHERE name = 'base'";

/** The query of the test: it returns one row. */
async function queryBase(c: Container): Promise<void> {
  const result = await c.sh(`psql -X -At -v ON_ERROR_STOP=1 -o /dev/null -c ${shellQuote(QUERY)} -c '\\echo :ROW_COUNT'`);
  if (dockerFailed(result)) throw new Verdict('unknown', `docker exec failed: ${output(result)}`);
  if (result.code !== 0) throw new Verdict('fail', `${QUERY} failed: ${output(result)}`);
  const rows = result.stdout.trim();
  if (rows !== '1') throw new Verdict('fail', `${QUERY} returned ${rows} rows, not 1`);
}

/** The JSON a WAL-G command printed; output that is not JSON is `unknown` with the parse error. */
function jsonOutput(label: string, out: string): unknown {
  try {
    return JSON.parse(out) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Verdict('unknown', `${label} printed no JSON (${error.message}): ${out.slice(0, 500)}`);
    throw error;
  }
}

/** The steps inside the container, in the order of `ogw.md` `## backup test`; `found` gets the newest base backup. */
async function inContainer(c: Container, inputs: Inputs, startedAt: number, found: { newest: BaseBackup | null }): Promise<void> {
  const key = secretKey(inputs.secretName);
  const listOut = await c.must('wal-g backup-list --detail --json', `${key} wal-g backup-list --detail --json`);
  const backups = parseBackupList(jsonOutput('wal-g backup-list --detail --json', listOut));
  if (backups === null) throw new Verdict('unknown', `wal-g backup-list --detail --json printed no list of base backups: ${listOut.slice(0, 500)}`);
  found.newest = newestBackup(backups);
  const showOut = await c.must('wal-g wal-show --detailed-json', `${key} wal-g wal-show --detailed-json`);
  const timelines = parseWalShow(jsonOutput('wal-g wal-show --detailed-json', showOut));
  if (timelines === null) throw new Verdict('unknown', `wal-g wal-show --detailed-json printed no list of timelines: ${showOut.slice(0, 500)}`);
  const wal = walCheckFailure(backups, timelines);
  if (wal !== null) throw new Verdict('fail', wal);
  const age = found.newest === null ? 'the backup storage has no base backup' : ageFailure(found.newest, startedAt, inputs.backup.baseBackupIntervalMs);
  if (age !== null) throw new Verdict('fail', age);
  await c.must('wal-g backup-fetch', `${key} wal-g backup-fetch "$PGDATA" LATEST`);
  await recover(c);
  await queryBase(c);
}

/** The restore test of `ogw.md` `## backup test`; reads nothing back from and writes nothing to the backup storage but WAL-G reads. */
export async function backupTest(ctx: Context, game: GameRepo, env: Env, startedAt: number): Promise<BackupTestResult> {
  const found: { newest: BaseBackup | null } = { newest: null };
  const result = (verdict: 'pass' | 'fail' | 'unknown', reason: string | null): BackupTestResult => ({
    started_at: startedAt,
    result: verdict,
    reason,
    base_backup: found.newest?.name ?? null,
    base_backup_finished_at: found.newest?.finishedAt ?? null,
  });
  try {
    const inputs = await readInputs(ctx, game, env);
    const container = await startContainer(ctx, inputs, await walgForDocker(ctx));
    try {
      await inContainer(container, inputs, startedAt, found);
    } finally {
      await removeContainer(container.id, ctx.env);
    }
    return result('pass', null);
  } catch (error) {
    if (error instanceof Verdict) return result(error.result, error.reason);
    throw error;
  }
}

export const test: CommandDef = {
  name: ['backup', 'test'],
  usage: 'ogw backup test <game> <DEV|STG|PROD>',
  async run(ctx, args) {
    expectPositionals(args, 2, 2, this.usage);
    const startedAt = Date.now();
    const game = await ctx.game(positional(args, 0, 'game'));
    const env = parseEnv(positional(args, 1, 'environment'));
    const result = await backupTest(ctx, game, env, startedAt);
    await writeJsonAtomic(backupTestPath(game, env), result);
    return { exitCode: result.result === 'pass' ? 0 : 1, text: formatJson(result).trimEnd(), data: result };
  },
};
