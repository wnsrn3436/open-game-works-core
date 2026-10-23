import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveGame } from '../../../src/lib/game.ts';
import { changeRuns, listRuns, newRunState, type RunState } from '../../../src/lib/runstate.ts';
import { workspaceFrom, loadHarnessSettings } from '../../../src/lib/settings.ts';
import { commitAll, makeGame, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { REFERENCE_MD } from '../loop/helpers.ts';


export function env(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serverUrl: 'https://dev.example.com',
    corsAllowedOrigins: [],
    trustedProxyCount: 1,
    updatePublicKeys: ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='],
    adminOperators: [{ name: 'ogw', roles: ['read', 'release', 'ops'], secret: 'adminOgw' }],
    secrets: { db: 'db', accessTokenKey: 'atk', updateSigningKey: 'usk', deploySsh: 'deploySsh', dbPassword: 'dbPassword' },
    adapters: {},
    deploy: { host: 'deploy.example.com', hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA', user: 'deployer', dir: '/srv/game', port: 8080 },
    ...extra,
  };
}

export function gameSettings(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: 'godot',
    coreVersion: '1.0.0',
    coreModules: { client: [], server: [] },
    appId: 'com.example.game',
    supportedLanguages: ['ko'],
    buildPlatforms: ['linux'],
    serverImage: { repository: 'ghcr.io/example/game-server' },
    postgresqlMajor: 18,
    environments: {
      DEV: env({ secrets: { db: 'db', accessTokenKey: 'atk', updateSigningKey: 'usk', deploySsh: 'deploySsh', dbPassword: 'dbPassword', devAccess: 'devAccess' } }),
      STG: env({ serverUrl: 'https://stg.example.com' }),
      PROD: {
        ...env({ serverUrl: 'https://prod.example.com', adapters: { cdn: 'cdn-r2' } }),
        cdnR2: { accountId: 'acct', bucket: 'game', accessKeyId: 'key', publicBaseUrl: 'https://cdn.example.com' },
        secrets: { db: 'db', accessTokenKey: 'atk', updateSigningKey: 'usk', cdn: 'cdn' },
        deploy: undefined,
      },
    },
    ...patch,
  };
}

/** A game repo with settings, a `.gitignore` for `builds/`, and the reference with its gameplay video. */
export function setupGame(ws: TestWorkspace, name = 'g', patch: Record<string, unknown> = {}, files: Record<string, string | object> = {}): string {
  return makeGame(ws, name, {
    'settings.json': JSON.parse(JSON.stringify(gameSettings(patch))) as object,
    '.gitignore': 'builds/\nclient/build/\nserver/build/\n',
    'records/setup/reference/reference.md': REFERENCE_MD,
    'records/setup/reference/hollow.mp4': 'video',
    ...files,
  });
}

export async function gameRepo(ws: TestWorkspace, name = 'g', cwd = ws.root) {
  return resolveGame(workspaceFrom(await loadHarnessSettings(ws.env), ws.env), name, cwd);
}

/** Opens a build run as `ogw build start` would, on a new branch made from main HEAD. */
export async function openBuildRun(ws: TestWorkspace, dir: string, fields: Partial<RunState> = {}): Promise<RunState> {
  const envName = fields.env ?? 'DEV';
  const version = fields.version ?? '0.1.0';
  const branch = `build/${envName.toLowerCase()}-${version}`;
  const base = sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
  sh(dir, 'git', ['checkout', '--quiet', '-b', branch]);
  const run = newRunState({ name: `build-${envName.toLowerCase()}-${version}`, kind: 'build', branch, baseCommit: base, env: envName, version, ...fields });
  const game = await gameRepo(ws, dir.split('/').at(-1));
  await changeRuns(game, (runs) => {
    runs.push(run);
  });
  return run;
}

export async function runsOf(ws: TestWorkspace, name = 'g'): Promise<RunState[]> {
  return listRuns(await gameRepo(ws, name));
}

export function write(dir: string, path: string, content: string | object): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

export function commit(dir: string, message = 'change'): string {
  return commitAll(dir, message);
}

export function git(dir: string, ...args: string[]): string {
  return sh(dir, 'git', args).trim();
}

/**
 * Fake programs at the front of PATH. Each script logs `<name> <args>` to `<bin>/calls.log`
 * and then runs `body` (sh). Returns the env patch and the log path.
 */
export function fakeBin(ws: TestWorkspace, scripts: Record<string, string>): { env: NodeJS.ProcessEnv; log: string; bin: string } {
  const bin = join(ws.root, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  const log = join(bin, 'calls.log');
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  }
  return { env: { PATH: `${bin}:${process.env.PATH ?? ''}` }, log, bin };
}

export function setSecrets(ws: TestWorkspace, values: Record<string, string>): void {
  writeFileSync(ws.env.OGW_TEST_SECRET_FILE as string, JSON.stringify(values));
}

/** Adds secrets to the ones `setSecrets` set. */
export function addSecrets(ws: TestWorkspace, values: Record<string, string>): void {
  const file = ws.env.OGW_TEST_SECRET_FILE as string;
  const current = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {};
  writeFileSync(file, JSON.stringify({ ...current, ...values }));
}
