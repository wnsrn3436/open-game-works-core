import { postgresDataPath } from '../../../lib/docker-postgres.ts';
import { shellQuote } from './ssh.ts';

/** The WAL-G settings and the backup service of the DB backup rule (`build` `## deploy`), from the environment's `backup`. */
export interface ComposeBackup {
  /** Secret name of `secrets.backup`: the secret access key of `accessKeyId`. */
  secret: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  walSwitchMs: number;
  baseBackupIntervalMs: number;
  retentionMs: number;
}

export interface ComposeInput {
  game: string;
  /** Lower-case environment name. */
  env: string;
  /** Upper-case environment name for `--env`. */
  envArg: string;
  dir: string;
  port: number;
  postgres: { tag: string; digest: string };
  serverImage: string;
  matchmaker: boolean;
  dbPasswordSecret: string;
  /** Secret names the server receives. */
  serverSecrets: string[];
  log: { maxBytes: number; maxFiles: number };
  /** With a PROD tag: WAL archiving in `db` and the `backup` service. */
  backup: ComposeBackup | null;
}

/** Container port of the ops paths of the server image (`server-image.md`). */
const OPS_PORT = 9464;

/** A YAML double-quoted value that Compose does not interpolate: `$` is written `$$`. */
const q = (value: string | number): string => JSON.stringify(String(value).replace(/\$/g, () => '$$'));

/** Where the WAL-G binary of `tools.walg` is mounted in the `db` and `backup` containers. */
const WALG_PATH = '/usr/local/bin/wal-g';

function logging(input: ComposeInput): string[] {
  return [
    '    logging:',
    '      driver: "json-file"',
    '      options:',
    `        max-size: ${q(input.log.maxBytes)}`,
    `        max-file: ${q(input.log.maxFiles)}`,
  ];
}

function list(key: string, items: readonly string[]): string[] {
  return [`    ${key}:`, ...items.map((item) => `      - ${q(item)}`)];
}

/** The environment variables of the WAL-G settings (`ogw.md` `## deploy`). */
function walgEnvironment(backup: ComposeBackup): string[] {
  return [
    `      WALG_S3_PREFIX: ${q(`s3://${backup.bucket}/${backup.prefix}`)}`,
    `      AWS_ENDPOINT: ${q(backup.endpoint)}`,
    `      AWS_REGION: ${q(backup.region)}`,
    `      AWS_ACCESS_KEY_ID: ${q(backup.accessKeyId)}`,
    '      AWS_S3_FORCE_PATH_STYLE: "true"',
  ];
}

function volumes(input: ComposeInput, readOnlyData: boolean): string[] {
  const data = postgresDataPath(input.postgres.tag);
  const lines = ['    volumes:'];
  if (readOnlyData) lines.push('      - type: "volume"', '        source: "db-data"', `        target: ${q(data)}`, '        read_only: true');
  else lines.push(`      - ${q(`db-data:${data}`)}`);
  if (input.backup !== null) {
    lines.push('      - type: "bind"', `        source: ${q(`${input.dir}/bin/wal-g`)}`, `        target: ${q(WALG_PATH)}`, '        read_only: true');
  }
  return lines;
}

/** `AWS_SECRET_ACCESS_KEY` of a WAL-G command, read from the Docker secret file of `secrets.backup`. */
function secretKey(backup: ComposeBackup): string {
  return `AWS_SECRET_ACCESS_KEY="$(cat ${shellQuote(`/run/secrets/${backup.secret}`)})"`;
}

/** The PostgreSQL settings of WAL archiving: `archive_timeout` is `walSwitchMs` in whole seconds, never above it. */
function dbCommand(backup: ComposeBackup | null): string[] {
  if (backup === null) return [];
  const args = [
    'postgres',
    '-c', 'archive_mode=on',
    '-c', `archive_timeout=${String(Math.floor(backup.walSwitchMs / 1000))}`,
    '-c', `archive_command=${secretKey(backup)} wal-g wal-push %p`,
  ];
  return [`    command: [${args.map(q).join(', ')}]`];
}

/**
 * The loop of the `backup` service: once a minute it reads `wal-g backup-list --json` (the `time` of an item is when
 * its base backup finished); without a base backup or when the newest finished `baseBackupIntervalMs` or more ago, it
 * pushes one of the data folder of `db`, then deletes the base backups before the newest one that finished more than
 * `retentionMs` ago. psql reads the JSON. Any failed command ends the container (`set -e`).
 */
export function backupScript(backup: ComposeBackup, dbPasswordSecret: string): string {
  const items = "FROM json_array_elements(:'list'::json) b";
  const finished = "extract(epoch FROM (b->>'time')::timestamptz) * 1000";
  return [
    'set -eu',
    secretKey(backup),
    `PGPASSWORD="$(cat ${shellQuote(`/run/secrets/${dbPasswordSecret}`)})"`,
    'export AWS_SECRET_ACCESS_KEY PGPASSWORD',
    `sql() { printf '%s\\n' "$2" | psql -X -At -v ON_ERROR_STOP=1 -v "list=$1"; }`,
    'while :; do',
    '  list="$(wal-g backup-list --json)"',
    `  newest="$(sql "$list" "SELECT coalesce(max(${finished})::bigint, -1) ${items}")"`,
    '  now="$(($(date +%s) * 1000))"',
    `  if [ "$newest" -lt 0 ] || [ "$((now - newest))" -ge ${String(backup.baseBackupIntervalMs)} ]; then`,
    '    wal-g backup-push "$PGDATA"',
    '    list="$(wal-g backup-list --json)"',
    '    now="$(($(date +%s) * 1000))"',
    `    old="$(sql "$list" "SELECT b->>'backup_name' ${items} WHERE ${finished} < $now - ${String(backup.retentionMs)} ORDER BY ${finished} DESC LIMIT 1")"`,
    '    if [ -n "$old" ]; then wal-g delete before FIND_FULL "$old" --confirm; fi',
    '  fi',
    '  sleep 60',
    'done',
  ].join('\n');
}

function dbService(input: ComposeInput): string[] {
  const secrets = input.backup === null ? [input.dbPasswordSecret] : [...new Set([input.backup.secret, input.dbPasswordSecret])].sort();
  return [
    '  db:',
    `    image: ${q(`postgres:${input.postgres.tag}@${input.postgres.digest}`)}`,
    ...dbCommand(input.backup),
    '    environment:',
    `      POSTGRES_PASSWORD_FILE: ${q(`/run/secrets/${input.dbPasswordSecret}`)}`,
    ...(input.backup === null ? [] : walgEnvironment(input.backup)),
    ...list('secrets', secrets),
    ...volumes(input, false),
    '    healthcheck:',
    '      test: ["CMD", "pg_isready", "-U", "postgres"]',
    '      interval: "2s"',
    '      timeout: "5s"',
    '      retries: 30',
    ...logging(input),
  ];
}

function backupService(input: ComposeInput, backup: ComposeBackup): string[] {
  return [
    '  backup:',
    `    image: ${q(`postgres:${input.postgres.tag}@${input.postgres.digest}`)}`,
    `    entrypoint: [${['/bin/sh', '-c', backupScript(backup, input.dbPasswordSecret)].map(q).join(', ')}]`,
    '    environment:',
    ...walgEnvironment(backup),
    '      PGHOST: "db"',
    '      PGUSER: "postgres"',
    ...list('secrets', [...new Set([backup.secret, input.dbPasswordSecret])].sort()),
    ...volumes(input, true),
    '    depends_on:',
    '      db:',
    '        condition: "service_healthy"',
    '    restart: "unless-stopped"',
    ...logging(input),
  ];
}

/** `<dir>/compose.yaml` of `ogw deploy` (`ogw.md` `## deploy`). */
export function composeYaml(input: ComposeInput): string {
  const serverSecrets = [...new Set(input.serverSecrets)].sort();
  const secrets = [...new Set([input.dbPasswordSecret, ...serverSecrets, ...(input.backup === null ? [] : [input.backup.secret])])].sort();
  const command = ['--env', input.envArg, ...(input.matchmaker ? ['--matchmaker'] : [])];
  const lines = [
    `name: ${q(`${input.game}-${input.env}`)}`,
    'services:',
    ...dbService(input),
    ...(input.backup === null ? [] : backupService(input, input.backup)),
    '  server:',
    `    image: ${q(input.serverImage)}`,
    `    command: [${command.map(q).join(', ')}]`,
    '    ports:',
    `      - ${q(`127.0.0.1:${String(input.port)}:8080`)}`,
    `      - ${q(`127.0.0.1:${String(input.port + 1)}:${String(OPS_PORT)}`)}`,
    ...list('secrets', serverSecrets),
    '    depends_on:',
    '      db:',
    '        condition: "service_healthy"',
    '    restart: "unless-stopped"',
    ...logging(input),
    'volumes:',
    '  db-data: {}',
    'secrets:',
    ...secrets.flatMap((name) => [`  ${q(name)}:`, `    file: ${q(`${input.dir}/secrets/${name}`)}`]),
  ];
  return `${lines.join('\n')}\n`;
}
