import { postgresDataPath } from '../../../lib/docker-postgres.ts';

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
}

const q = (value: string | number): string => JSON.stringify(String(value));

function logging(input: ComposeInput): string[] {
  return [
    '    logging:',
    '      driver: "json-file"',
    '      options:',
    `        max-size: ${q(input.log.maxBytes)}`,
    `        max-file: ${q(input.log.maxFiles)}`,
  ];
}

/** `<dir>/compose.yaml` of `ogw deploy` (`ogw.md` `## deploy`). */
export function composeYaml(input: ComposeInput): string {
  const secrets = [...new Set([input.dbPasswordSecret, ...input.serverSecrets])].sort();
  const serverSecrets = [...new Set(input.serverSecrets)].sort();
  const command = ['--env', input.envArg, ...(input.matchmaker ? ['--matchmaker'] : [])];
  const lines = [
    `name: ${q(`${input.game}-${input.env}`)}`,
    'services:',
    '  db:',
    `    image: ${q(`postgres:${input.postgres.tag}@${input.postgres.digest}`)}`,
    '    environment:',
    `      POSTGRES_PASSWORD_FILE: ${q(`/run/secrets/${input.dbPasswordSecret}`)}`,
    '    secrets:',
    `      - ${q(input.dbPasswordSecret)}`,
    '    volumes:',
    `      - ${q(`db-data:${postgresDataPath(input.postgres.tag)}`)}`,
    '    healthcheck:',
    '      test: ["CMD", "pg_isready", "-U", "postgres"]',
    '      interval: "2s"',
    '      timeout: "5s"',
    '      retries: 30',
    ...logging(input),
    '  server:',
    `    image: ${q(input.serverImage)}`,
    `    command: [${command.map(q).join(', ')}]`,
    '    ports:',
    `      - ${q(`127.0.0.1:${String(input.port)}:8080`)}`,
    '    secrets:',
    ...serverSecrets.map((name) => `      - ${q(name)}`),
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
