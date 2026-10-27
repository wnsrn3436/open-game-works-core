import { randomBytes } from 'node:crypto';
import { copyFile, link, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists } from '../../../lib/fsx.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { withLock } from '../../../lib/lock.ts';
import { runOk } from '../../../lib/proc.ts';
import { newSecretFolder } from '../../../lib/secret-files.ts';
import { gameSecretService, ogwKeychainFolder } from '../../../lib/secrets.ts';
import type { GameSettings } from '../../../lib/settings.ts';
import { buildToolProgram, hostPlatform } from '../../env/api.ts';
import type { BuildTool } from './host.ts';
import type { Env } from './names.ts';
import { freeSigning } from './signing-method.ts';

/** Signing material of one export: process env, preset options, credential options, and its cleanup. */
export interface Signing {
  env: NodeJS.ProcessEnv;
  options: Record<string, unknown>;
  credentials: Record<string, unknown>;
  /** iOS, macOS: the temporary keychain that holds the signing certificate until `cleanup`. */
  keychain?: string;
  cleanup(): Promise<void>;
}

export const ENDPOINTS = { entraToken: 'https://login.microsoftonline.com' };

function secretOf(ctx: Context, game: string, settings: GameSettings, platform: string, key: string): string {
  const name = ((settings.signing ?? {}) as Record<string, Record<string, string> | undefined>)[platform]?.[key];
  if (name === undefined) throw new OgwError(`game settings signing.${platform}.${key} is missing`);
  const value = ctx.secrets.get(gameSecretService(game, 'signing', name));
  if (value === null) throw new OgwError(`signing secret ${name} is not in the secret store`);
  return value;
}

/** A new owner-only folder for the signing material, which the play and judge sandbox blocks. */
async function tempDir(ctx: Context): Promise<string> {
  return newSecretFolder('ogw-signing-', ctx.env);
}

async function android(ctx: Context, game: string, settings: GameSettings, env: Env): Promise<Signing> {
  const dir = await tempDir(ctx);
  const keystore = join(dir, 'release.keystore');
  await writeFile(keystore, Buffer.from(secretOf(ctx, game, settings, 'android', 'keystore'), 'base64'), { mode: 0o600 });
  const kind = env === 'DEV' ? 'DEBUG' : 'RELEASE';
  const alias = settings.androidKeyAlias;
  if (typeof alias !== 'string') throw new OgwError('game settings androidKeyAlias is missing');
  return {
    env: {
      [`GODOT_ANDROID_KEYSTORE_${kind}_PATH`]: keystore,
      [`GODOT_ANDROID_KEYSTORE_${kind}_USER`]: alias,
      [`GODOT_ANDROID_KEYSTORE_${kind}_PASSWORD`]: secretOf(ctx, game, settings, 'android', 'password'),
    },
    options: {},
    credentials: {},
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const sec = (ctx: Context, args: string[], input?: string): Promise<string> =>
  runOk('security', args, { env: ctx.env, input, timeoutMs: LIMITS.shortMs }).then((r) => r.stdout);

/** One argument of a `security -i` command line: double-quoted, with `\\` and `"` escaped. */
export function securityArg(value: string): string {
  if (/[\n\r\0]/.test(value)) throw new OgwError('a security argument has a line break or NUL');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** A `security` command with a secret argument: the command reaches `security -i` through stdin, not its command line. */
const secSecret = (ctx: Context, args: string[]): Promise<string> => sec(ctx, ['-i'], `${args.map(securityArg).join(' ')}\n`);

/** `UUID` of a provisioning profile file. */
export async function profileUuid(ctx: Context, file: string): Promise<string> {
  const plist = await sec(ctx, ['cms', '-D', '-i', file]);
  const m = /<key>UUID<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
  if (!m) throw new OgwError('provisioning profile has no UUID');
  return m[1] as string;
}

function searchList(out: string): string[] {
  return out
    .split('\n')
    .map((l) => l.trim().replace(/^"|"$/g, ''))
    .filter((l) => l.length > 0);
}

/** The keychain search list lock of `## signing`, shared by the ogw processes of the OS user. */
function searchListLock(env: NodeJS.ProcessEnv): string {
  return join(ogwKeychainFolder(env), 'search-list.lock');
}

const userSearchList = async (ctx: Context): Promise<string[]> => searchList(await sec(ctx, ['list-keychains', '-d', 'user']));

/**
 * Takes the keychain out of the user keychain search list as it is now and deletes the keychain, inside the keychain
 * search list lock; each step runs even when another failed.
 */
async function removeKeychain(ctx: Context, keychain: string): Promise<void> {
  await withLock(searchListLock(ctx.env), async () => {
    const list = await userSearchList(ctx).catch(() => null);
    if (list !== null) await sec(ctx, ['list-keychains', '-d', 'user', '-s', ...list.filter((k) => k !== keychain)]).catch(() => undefined);
    await sec(ctx, ['delete-keychain', keychain]).catch(() => undefined);
  }).catch(() => undefined);
}

/**
 * Creates the keychain with a random password at the front of the user keychain search list, inside the keychain
 * search list lock, unlocks it without auto-lock, and imports the certificate with its password so that `codesign`
 * uses the key without asking.
 */
async function importCertificate(ctx: Context, keychain: string, p12: string, certPassword: string): Promise<void> {
  const password = randomBytes(24).toString('base64url');
  await withLock(searchListLock(ctx.env), async () => {
    // `create-keychain` also adds the keychain to the search list
    const list = (await userSearchList(ctx)).filter((k) => k !== keychain);
    await secSecret(ctx, ['create-keychain', '-p', password, keychain]);
    await sec(ctx, ['list-keychains', '-d', 'user', '-s', keychain, ...list]);
  });
  await secSecret(ctx, ['unlock-keychain', '-p', password, keychain]);
  await sec(ctx, ['set-keychain-settings', keychain]);
  await secSecret(ctx, ['import', p12, '-k', keychain, '-P', certPassword, '-T', '/usr/bin/codesign']);
  await secSecret(ctx, ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
}

/**
 * The SHA-1 hash of the one valid code signing identity of the keychain, which must be a `Developer ID Application`
 * certificate (`build` engines/godot.md `## signing`).
 */
export async function developerIdIdentity(ctx: Context, keychain: string): Promise<string> {
  const out = await sec(ctx, ['find-identity', '-v', '-p', 'codesigning', keychain]);
  const identities = [...out.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]*)"/gm)].map((m) => ({ hash: m[1] as string, name: m[2] as string }));
  const developerId = identities.filter((identity) => identity.name.startsWith('Developer ID Application:'));
  if (developerId.length !== 1) {
    throw new OgwError(`the macos signing certificate must hold one Developer ID Application identity; it holds: ${identities.map((i) => i.name).join(', ') || 'none'}`);
  }
  return (developerId[0] as { hash: string }).hash;
}

async function ios(ctx: Context, game: string, settings: GameSettings, env: Env): Promise<Signing> {
  const kind = env === 'DEV' ? 'development' : 'distribution';
  const dir = await tempDir(ctx);
  const keychain = join(dir, 'ogw.keychain-db');
  const placed: string[] = [];
  const cleanup = async (): Promise<void> => {
    await removeKeychain(ctx, keychain);
    for (const file of placed) await rm(file, { force: true });
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const p12 = join(dir, 'cert.p12');
    await writeFile(p12, Buffer.from(secretOf(ctx, game, settings, 'ios', `${kind}Certificate`), 'base64'), { mode: 0o600 });
    await importCertificate(ctx, keychain, p12, secretOf(ctx, game, settings, 'ios', `${kind}CertificatePassword`));
    const profile = join(dir, 'profile.mobileprovision');
    await writeFile(profile, Buffer.from(secretOf(ctx, game, settings, 'ios', `${kind}ProvisioningProfile`), 'base64'), { mode: 0o600 });
    const uuid = await profileUuid(ctx, profile);
    const home = ctx.env.HOME ?? homedir();
    for (const folder of [join(home, 'Library/MobileDevice/Provisioning Profiles'), join(home, 'Library/Developer/Xcode/UserData/Provisioning Profiles')]) {
      const target = join(folder, `${uuid}.mobileprovision`);
      if (exists(target)) continue;
      await mkdir(folder, { recursive: true });
      await copyFile(profile, target);
      placed.push(target);
    }
    const suffix = env === 'DEV' ? 'debug' : 'release';
    return { env: {}, options: { [`application/provisioning_profile_uuid_${suffix}`]: uuid }, credentials: {}, keychain, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function macos(ctx: Context, game: string, settings: GameSettings, env: Env): Promise<Signing> {
  const dir = await tempDir(ctx);
  let keychain: string | null = null;
  const cleanup = async (): Promise<void> => {
    if (keychain !== null) await removeKeychain(ctx, keychain);
    await rm(dir, { recursive: true, force: true });
  };
  const write = async (name: string, key: string): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, Buffer.from(secretOf(ctx, game, settings, 'macos', key), 'base64'), { mode: 0o600 });
    return path;
  };
  try {
    const p12 = await write('cert.p12', 'certificate');
    const certPassword = secretOf(ctx, game, settings, 'macos', 'certificatePassword');
    const team = settings.appleTeamId;
    if (typeof team !== 'string' || team === '') throw new OgwError('game settings appleTeamId is missing');
    const notary = settings.macosNotary as { keyId?: string; issuerId?: string } | undefined;
    if (env !== 'DEV' && (!notary?.keyId || !notary.issuerId)) throw new OgwError('game settings macosNotary is missing');
    const credentials: Record<string, unknown> = { 'codesign/certificate_file': p12, 'codesign/certificate_password': certPassword };
    const options: Record<string, unknown> = { 'codesign/codesign': 3, 'codesign/apple_team_id': team, 'codesign/provisioning_profile': await write('profile.provisionprofile', 'provisioningProfile') };
    if (env !== 'DEV' && notary?.keyId && notary.issuerId) {
      options['notarization/notarization'] = 2;
      credentials['notarization/api_uuid'] = notary.issuerId;
      credentials['notarization/api_key_id'] = notary.keyId;
      credentials['notarization/api_key'] = await write('notary.p8', 'notaryApiKey');
    }
    keychain = join(dir, 'ogw.keychain-db');
    await importCertificate(ctx, keychain, p12, certPassword);
    options['codesign/identity'] = await developerIdIdentity(ctx, keychain);
    return { env: {}, options, credentials, keychain, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

const NONE: Signing = { env: {}, options: {}, credentials: {}, cleanup: () => Promise.resolve() };

/** The debug keystore of this host and its key (`build` `## platform build`); not a secret. */
export const DEBUG_KEYSTORE = { alias: 'androiddebugkey', password: 'android' };

export function debugKeystorePath(env: NodeJS.ProcessEnv): string {
  return join(env.HOME ?? homedir(), '.android', 'debug.keystore');
}

/** `keytool` next to an installed program of the `engine.json` `buildTools` items of platform android, else on PATH. */
async function androidKeytool(ctx: Context, buildTools: readonly BuildTool[]): Promise<string> {
  const host = hostPlatform(ctx.env);
  for (const tool of buildTools.filter((t) => t.platform === 'android' && host !== null && t.hosts.includes(host) && (t.downloads ?? []).length > 0)) {
    const program = await buildToolProgram(ctx, tool.name, tool.version);
    if (program === null) continue;
    for (const name of ['keytool', 'keytool.exe']) {
      if (exists(join(dirname(program), name))) return join(dirname(program), name);
    }
  }
  return 'keytool';
}

/**
 * The debug keystore, made with `keytool` when this host has none. It is made under another name and linked into
 * place, so a build that makes it at the same time keeps the first one.
 */
export async function ensureDebugKeystore(ctx: Context, buildTools: readonly BuildTool[]): Promise<string> {
  const path = debugKeystorePath(ctx.env);
  if (exists(path)) return path;
  await mkdir(dirname(path), { recursive: true });
  const made = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const { alias, password } = DEBUG_KEYSTORE;
    await runOk(
      await androidKeytool(ctx, buildTools),
      ['-genkeypair', '-noprompt', '-keystore', made, '-alias', alias, '-storepass', password, '-keypass', password, '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US'],
      { env: ctx.env, timeoutMs: LIMITS.programMs },
    );
    await link(made, path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
  } finally {
    await rm(made, { force: true });
  }
  return path;
}

/** Free signing of a DEV export (`build` engines/godot.md `## signing`): android debug keystore, macos ad-hoc, windows none. */
async function freeSigningOf(ctx: Context, platform: string, buildTools: () => Promise<readonly BuildTool[]>): Promise<Signing> {
  if (platform === 'macos') return { ...NONE, options: { 'codesign/codesign': 1 } };
  if (platform !== 'android') return NONE;
  const { alias, password } = DEBUG_KEYSTORE;
  return {
    ...NONE,
    env: { GODOT_ANDROID_KEYSTORE_DEBUG_PATH: await ensureDebugKeystore(ctx, await buildTools()), GODOT_ANDROID_KEYSTORE_DEBUG_USER: alias, GODOT_ANDROID_KEYSTORE_DEBUG_PASSWORD: password },
  };
}

/**
 * Signing preparation of `build` engines/godot.md `## signing` for one platform export. `buildTools` gives the
 * `engine.json` `buildTools` when free signing makes the debug keystore.
 */
export async function prepareSigning(
  ctx: Context,
  game: string,
  settings: GameSettings,
  env: Env,
  platform: string,
  buildTools: () => Promise<readonly BuildTool[]> = () => Promise.resolve([]),
): Promise<Signing> {
  if (freeSigning(settings, env, platform) !== null) return freeSigningOf(ctx, platform, buildTools);
  if (platform === 'android') return android(ctx, game, settings, env);
  if (platform === 'ios') return ios(ctx, game, settings, env);
  if (platform === 'macos') return macos(ctx, game, settings, env);
  return NONE;
}

async function entraToken(ctx: Context, game: string, settings: GameSettings): Promise<string> {
  const ts = settings.trustedSigning as { tenantId?: string; clientId?: string } | undefined;
  if (!ts?.tenantId || !ts.clientId) throw new OgwError('game settings trustedSigning is missing');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: ts.clientId,
    client_secret: secretOf(ctx, game, settings, 'windows', 'clientSecret'),
    scope: 'https://codesigning.azure.net/.default',
  });
  const response = await fetch(`${ENDPOINTS.entraToken}/${encodeURIComponent(ts.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(LIMITS.httpMs),
  });
  const json = (await response.json().catch(() => ({}))) as { access_token?: string };
  if (!response.ok || !json.access_token) throw new OgwError(`Microsoft Entra ID token request failed: HTTP ${String(response.status)}`);
  return json.access_token;
}

/** How to run `jsign`: the program, the arguments before jsign's own, and the process environment. */
export interface Signer {
  program: string;
  prefix: string[];
  env: NodeJS.ProcessEnv;
}

/** A build tool's program: the installed one for an item with `downloads`, else its `versionCommand` program on PATH. */
async function toolProgramOf(ctx: Context, tool: BuildTool): Promise<string> {
  if ((tool.downloads ?? []).length === 0) return tool.versionCommand.trim().split(/\s+/)[0] ?? tool.name;
  const program = await buildToolProgram(ctx, tool.name, tool.version);
  if (program === null) throw new OgwError(`build tool ${tool.name} ${tool.version} is not installed: run ogw env install-engines`);
  return program;
}

/**
 * `jsign` and the Java runtime that runs it, from the `engine.json` `buildTools` items of platform `windows` for this
 * host (`build` engines/godot.md `## signing`): the item `jsign` and the other item. A jsign `.jar` runs with
 * `java -jar`; an installed Java runtime goes first on PATH and is `JAVA_HOME`.
 */
export async function windowsSigner(ctx: Context, buildTools: readonly BuildTool[]): Promise<Signer> {
  const host = hostPlatform(ctx.env);
  const items = buildTools.filter((t) => t.platform === 'windows' && host !== null && t.hosts.includes(host));
  const jsignTool = items.find((t) => t.name === 'jsign');
  if (!jsignTool) throw new OgwError('engine.json buildTools has no windows item jsign for this host');
  const javaTool = items.find((t) => t !== jsignTool);
  const jsign = await toolProgramOf(ctx, jsignTool);
  const java = javaTool ? await toolProgramOf(ctx, javaTool) : 'java';
  const env = { ...ctx.env };
  if (javaTool && (javaTool.downloads ?? []).length > 0) {
    env.PATH = `${dirname(java)}${delimiter}${ctx.env.PATH ?? ''}`;
    env.JAVA_HOME = dirname(dirname(java));
  }
  if (jsign.endsWith('.jar')) return { program: java, prefix: ['-jar', jsign], env };
  return { program: jsign, prefix: [], env };
}

/** Signs `.exe` and `.dll` files with `jsign` on Azure Trusted Signing. */
export async function signWindows(ctx: Context, game: string, settings: GameSettings, files: string[], signer: Signer): Promise<void> {
  const ts = settings.trustedSigning as { endpoint?: string; account?: string; certificateProfile?: string } | undefined;
  if (!ts?.endpoint || !ts.account || !ts.certificateProfile) throw new OgwError('game settings trustedSigning is missing');
  const token = await entraToken(ctx, game, settings);
  const host = new URL(ts.endpoint).host;
  // the access token goes to jsign as a file, never on its command line
  const dir = await tempDir(ctx);
  try {
    const tokenFile = join(dir, 'access-token');
    await writeFile(tokenFile, token, { mode: 0o600 });
    for (const file of files) {
      await runOk(
        signer.program,
        [...signer.prefix, '--storetype', 'TRUSTEDSIGNING', '--keystore', host, '--storepass', `file:${tokenFile}`, '--alias', `${ts.account}/${ts.certificateProfile}`,
          '--tsaurl', 'http://timestamp.acs.microsoft.com', '--tsmode', 'RFC3161', '--alg', 'SHA-256', file],
        { env: signer.env, timeoutMs: LIMITS.programMs },
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
