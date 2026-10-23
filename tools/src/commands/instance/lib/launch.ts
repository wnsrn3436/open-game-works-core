import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';

/** A process the runner starts. */
export interface Launch {
  command: string;
  args: string[];
  cwd: string;
}

/** A free loopback TCP port. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolvePromise) => {
    server.close(() => {
      resolvePromise();
    });
  });
  return port;
}

/** Secret values a LOCAL server takes as server start arguments (server-core `## adapter`), new for each instance. */
export interface LocalSecrets {
  accessTokenKey: string;
  updateSigningKey: string;
  iapAccountToken: string;
  devAccess: string;
  /** admin secret of the operator `ogw`. */
  adminSecret: string;
}

/** Ed25519 private key seed (32 bytes), standard base64 (ogw.md `## secret generate`). */
function ed25519Seed(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  return der.subarray(der.length - 32).toString('base64');
}

/** Secure random 32 bytes, base64url without padding. */
function random32(): string {
  return randomBytes(32).toString('base64url');
}

export function newLocalSecrets(): LocalSecrets {
  return {
    accessTokenKey: ed25519Seed(),
    updateSigningKey: ed25519Seed(),
    iapAccountToken: random32(),
    devAccess: random32(),
    adminSecret: random32(),
  };
}

/**
 * Writes a JSON object of secret values to a new file only its owner can read and write (0600). The runner gives a
 * process secret values only through such a file in the instance folder, never on its command line.
 */
export function writeSecretFile(path: string, values: Readonly<Record<string, string>>): void {
  writeFileSync(path, `${JSON.stringify(values)}\n`, { mode: 0o600, flag: 'wx' });
}

/**
 * The database of an instance server (server-core `## server start` `--db`): a SQLite file, or a PostgreSQL
 * database whose connection string (it holds the password) goes only in the secret file under key `db`.
 */
export type ServerDb = { kind: 'sqlite'; file: string } | { kind: 'postgresql'; url: string };

/** The `--secret-file` content of an instance server (server-core `## server start`): secret key → value. */
export function serverSecretValues(secrets: LocalSecrets, db: ServerDb): Record<string, string> {
  return {
    accessTokenKey: secrets.accessTokenKey,
    updateSigningKey: secrets.updateSigningKey,
    iapAccountToken: secrets.iapAccountToken,
    devAccess: secrets.devAccess,
    'adminSecret.ogw': secrets.adminSecret,
    ...(db.kind === 'postgresql' ? { db: db.url } : {}),
  };
}

export interface ServerStart {
  root: string;
  port: number;
  db: ServerDb;
  matchmaker: boolean;
  /** The secret file with `serverSecretValues`. */
  secretFile: string;
}

/** Server start arguments (server-core `## server start`) of an instance server. */
export function serverStartArgs(start: ServerStart): string[] {
  const args = ['--env', 'LOCAL', '--port', String(start.port), '--db', start.db.kind === 'sqlite' ? start.db.file : 'postgresql'];
  if (start.matchmaker) args.push('--matchmaker');
  args.push('--secret-file', start.secretFile);
  return args;
}

/** The server process of an instance: `node core/start.ts <server start arguments>` in the checkout's `server/`. */
export function serverLaunch(start: ServerStart): Launch {
  return { command: process.execPath, args: ['core/start.ts', ...serverStartArgs(start)], cwd: join(start.root, 'server') };
}

/**
 * The program of the populate process: `populate(await connect_server(url, data folder, dev access))` from argv,
 * with the dev access value read from the server secret file.
 */
export const POPULATE_SCRIPT = [
  "const { readFileSync } = await import('node:fs');",
  "const { pathToFileURL } = await import('node:url');",
  'const [, url, data, secretFile] = process.argv;',
  "const devAccess = JSON.parse(readFileSync(secretFile, 'utf8')).devAccess;",
  "const testing = await import(pathToFileURL('core/testing/dev/index.ts').href);",
  "const content = await import(pathToFileURL('dev/populate.ts').href);",
  'await content.populate(await testing.connect_server(url, data, devAccess));',
].join('\n');

/**
 * Calls `populate(server)` of `server/dev/populate.ts` with the remote test server of `testing` `connect_server`
 * (ogw.md `## runner`), in a `node` process whose working folder is the checkout's `server/`.
 */
export function populateLaunch(target: { root: string; serverUrl: string; secretFile: string }): Launch {
  return {
    command: process.execPath,
    args: ['--input-type=module', '-e', POPULATE_SCRIPT, '--', target.serverUrl, serverDataFolder(target.root), target.secretFile],
    cwd: join(target.root, 'server'),
  };
}

/** The server build data folder the docs give for server code. */
export function serverDataFolder(root: string): string {
  return join(root, 'server', 'build', 'data');
}

/** `rendering_method` of the Godot renderer table (client-content engines/godot `## engine settings`). */
const GODOT_RENDERING: Record<string, string> = {
  windows: 'forward_plus',
  macos: 'forward_plus',
  linux: 'forward_plus',
  android: 'mobile',
  ios: 'mobile',
  web: 'gl_compatibility',
};

export function renderingMethod(engine: string, platform: string): string {
  if (engine !== 'godot') throw new OgwError(`not defined: the dev run of engine ${engine}`);
  const method = GODOT_RENDERING[platform];
  if (!method) throw new OgwError(`unknown platform: ${platform}`);
  return method;
}

/** Launch values (bootstrap-core `## DEV`) of one client. */
export interface LaunchValues {
  OGW_SERVER_URL: string;
  OGW_INSTANCE_ID: string;
  OGW_AUTOMATION_PORT: string;
  OGW_AUTOMATION_TOKEN: string;
  OGW_DEV_ACCOUNT: string;
  OGW_DEV_ACCESS: string;
  OGW_PLATFORM: string;
}

/** The launch value file of a client (client-core engines/godot): the launch values that are not empty. */
export function launchValueFileContent(values: LaunchValues): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));
}

/** Frame rate of a movie maker recording: each frame advances the game by 1 / it seconds, however long it took to draw. */
export const MOVIE_FPS = 60;

/** Godot dev run of one client: `godot --path client` with the renderer and the launch value file; with `movie`, Godot's movie maker records it. */
export function clientLaunch(
  plan: { engine: string; enginePath: string; renderingMethod: string },
  root: string,
  headless: boolean,
  launchValueFile: string,
  movie: { file: string; resolution: [number, number] } | null = null,
): Launch {
  if (plan.engine !== 'godot') throw new OgwError(`not defined: the dev run of engine ${plan.engine}`);
  const args = ['--path', join(root, 'client'), '--rendering-method', plan.renderingMethod];
  if (headless) args.push('--headless');
  if (movie !== null) {
    const fps = String(MOVIE_FPS);
    args.push('--resolution', `${String(movie.resolution[0])}x${String(movie.resolution[1])}`, '--write-movie', movie.file, '--fixed-fps', fps);
  }
  args.push('--', `--launch-values=${launchValueFile}`);
  return { command: plan.enginePath, args, cwd: root };
}
