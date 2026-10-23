import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expectPositionals, parseTokens, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { readJsonIfExists, writeJsonAtomic } from '../../lib/fsx.ts';
import { LIMITS } from '../../lib/limits.ts';
import { adminCall, adminFailureStatus, adminNoFailureAnswer, adminSend, type AdminFailureData } from '../admin/api.ts';
import { envLower, parseEnv } from '../build/lib/names.ts';
import { commands as cloneCommands } from '../clone/index.ts';
import { gameModules, mergedCoreSettings } from '../generate/api.ts';
import { FAILED_STEP } from './api.ts';
import { composeYaml } from './lib/compose.ts';
import { nextDeployList, type DeployList } from './lib/deploylist.ts';
import { contentTypeOf, putObject } from './lib/s3.ts';
import { openSsh, shellQuote, type SshSession } from './lib/ssh.ts';
import { envSecret, filesBelow, loadDeployTarget, type DeployTarget } from './lib/target.ts';
import { gameSecretService } from '../../lib/secrets.ts';

/** Polling of the server start and the migration batch. Tests shorten it. */
export const POLL = { intervalMs: 2000, serverStartMs: LIMITS.httpMs, migrationMs: LIMITS.programMs };

interface StepLog {
  name: string;
  status: 'done' | 'skipped';
}

class Steps {
  readonly log: StepLog[] = [];
  async run(name: string, when: boolean, fn: () => Promise<void>): Promise<void> {
    if (!when) {
      this.log.push({ name, status: 'skipped' });
      return;
    }
    try {
      await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OgwError(`${FAILED_STEP}${name}\n${message}`, 1, { failedStep: name, steps: this.log });
    }
    this.log.push({ name, status: 'done' });
  }
}

/** The failure reason (`{"error": "<reason>"}` body) of an admin operation failure `adminSend` threw, or null. */
export function adminFailure(error: unknown): string | null {
  if (adminFailureStatus(error) === null) return null;
  const body = ((error as OgwError).data as AdminFailureData).body;
  const reason = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  return typeof reason === 'string' ? reason : null;
}

async function composeExists(ssh: SshSession, dir: string): Promise<boolean> {
  const result = await ssh.exec(`test -f ${shellQuote(`${dir}/compose.yaml`)}`);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new OgwError(`cannot reach the deploy host: ${(result.stderr || result.stdout).trim()}`);
}

async function readDeployList(ctx: Context, t: DeployTarget, ssh: SshSession): Promise<{ list: DeployList | null; compose: boolean }> {
  if (!(await composeExists(ssh, t.host.dir))) return { list: null, compose: false };
  try {
    const result = (await adminCall(ctx, t.game.name, { env: t.env }, 'get_deploy_list', {})) as { deploy_list?: DeployList } & Partial<DeployList>;
    return { list: result.deploy_list ?? { app: result.app ?? {}, patches: result.patches ?? {} }, compose: true };
  } catch (error) {
    if (adminFailure(error) === 'not_found') return { list: null, compose: true };
    // Step 1 removes the DB volume of this deploy anyway: a server that gave no `{"error": "<reason>"}` answer
    // (a stopped server, a proxy page) does not stop it, and the saved deploy list keeps the app.
    // A failure before the request was sent (no serverUrl, no operator secret) stops before step 1.
    if (wipesDb(t) && adminNoFailureAnswer(error)) return { list: null, compose: true };
    throw error;
  }
}

/** Whether step 1 removes the DB volume when `compose.yaml` is on the host: no PROD tag and a server image. */
function wipesDb(t: DeployTarget): boolean {
  return !t.hasProdTag && t.buildRun.serverImage !== null;
}

/** The deploy list last read from the environment's server, kept in the game repo `builds/` (`tools/ogw.md` `## deploy`). */
export function savedDeployListPath(t: Pick<DeployTarget, 'game' | 'env'>): string {
  return join(t.game.root, 'builds', `${envLower(t.env)}-deploy-list.json`);
}

/**
 * Reads the deploy list and saves it outside the host. Without one on the server (no `compose.yaml`,
 * `not_found` after step 1 of an earlier run removed the DB volume, or no admin failure answer before step 1
 * removes it) the saved one stands in, with no `patches`: the files of its patches are not on that server.
 */
async function readOrSavedDeployList(ctx: Context, t: DeployTarget, ssh: SshSession): Promise<{ list: DeployList | null; compose: boolean }> {
  const read = await readDeployList(ctx, t, ssh);
  const path = savedDeployListPath(t);
  if (read.list !== null) {
    await writeJsonAtomic(path, read.list);
    return read;
  }
  const saved = await readJsonIfExists<Partial<DeployList>>(path);
  return { list: saved === null ? null : { app: saved.app ?? {}, patches: {} }, compose: read.compose };
}

async function putUpdateFiles(ctx: Context, t: DeployTarget): Promise<void> {
  for (const file of t.updateFiles) {
    await adminSend(ctx, t.game.name, { env: t.env }, 'put_update_file', { query: { sha256: file.sha256 }, bytes: file.bytes });
  }
}

function serverSecrets(t: DeployTarget): string[] {
  const secrets = (t.envSettings.secrets ?? {}) as Record<string, string>;
  const names = Object.entries(secrets).filter(([key]) => key !== 'deploySsh' && key !== 'dbPassword').map(([, name]) => name);
  const operators = (t.envSettings.adminOperators ?? []) as { secret: string }[];
  return [...names, ...operators.map((op) => op.secret)];
}

/** A secret file to write: its secret name, file content (value and one line break) and mode. */
interface SecretFile {
  name: string;
  content: string;
  mode: '600' | '644';
}

/**
 * The secret files of `build` `## deploy` secret file rule from this host's secret store: `serverSecrets` and
 * `dbPassword`. Fails naming every missing secret before the host is touched.
 */
export function secretFiles(ctx: Context, t: DeployTarget): SecretFile[] {
  const dbPassword = (t.envSettings.secrets as Record<string, string> | undefined)?.dbPassword;
  if (dbPassword === undefined) throw new OgwError(`game settings environments.${t.env}.secrets.dbPassword is missing`);
  const names = [...new Set([dbPassword, ...serverSecrets(t)])].sort();
  const missing: string[] = [];
  const files: SecretFile[] = [];
  for (const name of names) {
    const value = ctx.secrets.get(gameSecretService(t.game.name, t.env, name));
    if (value === null) missing.push(name);
    else files.push({ name, content: `${value}\n`, mode: name === dbPassword ? '600' : '644' });
  }
  if (missing.length > 0) throw new OgwError(`secrets of ${t.env} not in the secret store: ${missing.join(', ')}`);
  return files;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** SHA-256 of the secret files on the host, by name; a missing file has none. */
async function hostHashes(ssh: SshSession, secretsDir: string, names: string[]): Promise<Map<string, string>> {
  const list = names.map(shellQuote).join(' ');
  const out = await ssh.execOk(`cd ${shellQuote(secretsDir)} && for f in ${list}; do if [ -f "$f" ]; then sha256sum -- "$f" || exit 1; fi; done`);
  const hashes = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m) hashes.set(m[2] as string, m[1] as string);
  }
  return hashes;
}

/**
 * Writes the secret files whose content on the host differs (`build` `## deploy` secret file rule) and sets the
 * mode of every one. Values go through stdin, never on a command line. Returns whether a file was written.
 */
async function writeSecretFiles(ctx: Context, t: DeployTarget, ssh: SshSession): Promise<boolean> {
  const files = secretFiles(ctx, t);
  const dir = `${t.host.dir}/secrets`;
  await ssh.execOk(`umask 077 && mkdir -p ${shellQuote(dir)} && chmod 700 ${shellQuote(dir)}`);
  const hashes = await hostHashes(ssh, dir, files.map((f) => f.name));
  const changed = files.filter((f) => hashes.get(f.name) !== sha256(f.content));
  const db = files.find((f) => f.mode === '600');
  if (t.hasProdTag && db !== undefined && hashes.has(db.name) && changed.includes(db)) {
    throw new OgwError(`the host's ${db.name} differs from the secret store; with a PROD tag the PostgreSQL password in the DB volume does not change`);
  }
  for (const file of changed) {
    const target = shellQuote(`${dir}/${file.name}`);
    const temp = shellQuote(`${dir}/.${file.name}.tmp`);
    await ssh.execOk(`umask 077 && cat > ${temp} && chmod ${file.mode} ${temp} && mv -f ${temp} ${target}`, { input: file.content });
  }
  for (const mode of ['600', '644'] as const) {
    const names = files.filter((f) => f.mode === mode).map((f) => shellQuote(f.name));
    if (names.length > 0) await ssh.execOk(`cd ${shellQuote(dir)} && chmod ${mode} -- ${names.join(' ')}`);
  }
  return changed.length > 0;
}

async function writeCompose(ctx: Context, t: DeployTarget, ssh: SshSession): Promise<void> {
  const image = t.buildRun.serverImage;
  if (!image) throw new OgwError('the build has no server image');
  const log = (t.envSettings.containerLog ?? {}) as { maxBytes?: number; maxFiles?: number };
  if (log.maxBytes === undefined || log.maxFiles === undefined) throw new OgwError(`game settings environments.${t.env}.containerLog is incomplete`);
  const dbPassword = (t.envSettings.secrets as Record<string, string>).dbPassword;
  if (dbPassword === undefined) throw new OgwError(`game settings environments.${t.env}.secrets.dbPassword is missing`);
  const modules = await gameModules(ctx, t.game);
  const yaml = composeYaml({
    game: t.game.name,
    env: envLower(t.env),
    envArg: t.env,
    dir: t.host.dir,
    port: t.host.port,
    postgres: (await ctx.settings()).tools.postgresql,
    serverImage: `${image.name}:${image.tag}`,
    matchmaker: modules.client.includes('RealtimeCore'),
    dbPasswordSecret: dbPassword,
    serverSecrets: serverSecrets(t),
    log: { maxBytes: log.maxBytes, maxFiles: log.maxFiles },
  });
  const dir = shellQuote(t.host.dir);
  const file = shellQuote(`${t.host.dir}/compose.yaml`);
  await ssh.execOk(`mkdir -p ${dir} && cat > ${file}.tmp && mv ${file}.tmp ${file}`, { input: yaml });
}

async function waitServer(t: DeployTarget): Promise<void> {
  const serverUrl = t.envSettings.serverUrl as string;
  const deadline = Date.now() + POLL.serverStartMs;
  for (;;) {
    const status = await fetch(`${serverUrl}/update/deploy_list.json`, { signal: AbortSignal.timeout(LIMITS.httpMs) })
      .then((r) => r.status)
      .catch(() => 0);
    if (status === 200 || status === 404) return;
    if (Date.now() >= deadline) throw new OgwError(`the server did not answer GET /update/deploy_list.json (last status ${String(status)})`);
    await sleep(POLL.intervalMs);
  }
}

async function startServer(ctx: Context, t: DeployTarget, ssh: SshSession): Promise<void> {
  const written = await writeSecretFiles(ctx, t, ssh);
  await writeCompose(ctx, t, ssh);
  const dir = shellQuote(t.host.dir);
  await ssh.execOk(`cd ${dir} && docker compose pull`);
  // a container reads its secret files when it starts: new files need new containers
  await ssh.execOk(`cd ${dir} && docker compose up --detach${written ? ' --force-recreate' : ''}`);
  await waitServer(t);
}

async function runMigration(ctx: Context, t: DeployTarget): Promise<void> {
  await adminCall(ctx, t.game.name, { env: t.env }, 'start_migration_batch', {});
  const deadline = Date.now() + POLL.migrationMs;
  for (;;) {
    const batch = (await adminCall(ctx, t.game.name, { env: t.env }, 'get_migration_batch', {})) as { status?: string; failed_count?: number };
    if (batch.status === 'DONE') return;
    if (batch.status !== 'RUNNING') throw new OgwError(`migration batch ended ${String(batch.status)}`);
    if (Date.now() >= deadline) throw new OgwError('migration batch did not end in time');
    await sleep(POLL.intervalMs);
  }
}

function cacheControl(core: Record<string, unknown>): string {
  const nested = (core['game-update'] as Record<string, unknown> | undefined)?.fileMaxAgeMs;
  const ms = core['game-update.fileMaxAgeMs'] ?? nested;
  if (typeof ms !== 'number') throw new OgwError('core settings game-update.fileMaxAgeMs is missing');
  return `public, max-age=${String(Math.floor(ms / 1000))}, immutable`;
}

/** The entry page: moves to the version folder's `index.html`, keeping the query string. */
export function entryPage(version: string): string {
  const target = JSON.stringify(`${version}/index.html`);
  return `<!doctype html>\n<html><head><meta charset="utf-8"><script>location.replace(${target} + location.search);</script></head><body></body></html>\n`;
}

async function uploadWeb(ctx: Context, t: DeployTarget, webDir: string): Promise<void> {
  const r2 = t.envSettings.cdnR2 as { accountId: string; bucket: string; accessKeyId: string } | undefined;
  if (!r2) throw new OgwError(`game settings environments.${t.env}.cdnR2 is missing`);
  const target = {
    endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
    bucket: r2.bucket,
    accessKeyId: r2.accessKeyId,
    secretAccessKey: envSecret(ctx, t, 'cdn'),
    region: 'auto',
  };
  const cache = cacheControl(await mergedCoreSettings(ctx, t.game));
  const env = envLower(t.env);
  for (const path of await filesBelow(webDir)) {
    const name = relative(webDir, path).split('\\').join('/');
    await putObject(target, { key: `web/${env}/${t.version}/${name}`, body: await readFile(path), contentType: contentTypeOf(name), cacheControl: cache });
  }
  await putObject(target, {
    key: `web/${env}/index.html`,
    body: Buffer.from(entryPage(t.version)),
    contentType: contentTypeOf('index.html'),
    cacheControl: 'no-cache',
  });
}

async function cloneSweep(ctx: Context, t: DeployTarget): Promise<void> {
  const def = cloneCommands.find((c) => c.name.join(' ') === 'clone sweep');
  if (!def) throw new OgwError('ogw clone sweep is not available');
  const result = await def.run(ctx, parseTokens([t.game.name, t.env], def.options ?? {}));
  if ((result.exitCode ?? 0) !== 0) throw new OgwError(`ogw clone sweep ended ${String(result.exitCode)}: ${result.text ?? ''}`);
}

async function deploySteps(ctx: Context, t: DeployTarget, ssh: SshSession, steps: Steps): Promise<void> {
  let read: { list: DeployList | null; compose: boolean } = { list: null, compose: false };
  await steps.run('0. get_deploy_list', true, async () => {
    read = await readOrSavedDeployList(ctx, t, ssh);
  });
  const image = t.buildRun.serverImage !== null;
  const files = t.updateFiles.length > 0;
  const wipe = wipesDb(t) && read.compose;
  // Update files go to the running server before the new one starts only when there is one (`compose.yaml`).
  const uploadFirst = t.hasProdTag && read.compose;
  await steps.run('1. docker compose down --volumes', wipe, () => ssh.execOk(`cd ${shellQuote(t.host.dir)} && docker compose down --volumes`).then(() => undefined));
  await steps.run('2. put_update_file', uploadFirst && files, () => putUpdateFiles(ctx, t));
  await steps.run('3. docker compose up', image, () => startServer(ctx, t, ssh));
  await steps.run('4. put_update_file', !uploadFirst && files, () => putUpdateFiles(ctx, t));
  await steps.run('5. start_migration_batch', t.hasProdTag && image, () => runMigration(ctx, t));
  await steps.run('6. publish_deploy_list', true, async () => {
    // Without a server image the running server stays, and so do the read entries it accepts.
    const compat = image ? (t.buildRun.serverDataVersions?.compat_client_data_version ?? '') : null;
    const next = nextDeployList({ read: read.list, dbWiped: wipe, update: t.update, patch: t.patch, compat });
    await adminCall(ctx, t.game.name, { env: t.env }, 'publish_deploy_list', next);
  });
  await steps.run('7. web hosting', t.webDir !== null, () => uploadWeb(ctx, t, t.webDir as string));
  await steps.run('8. ogw clone sweep', t.hasProdTag, () => cloneSweep(ctx, t));
}

export const deploy: CommandDef = {
  name: ['deploy'],
  usage: 'ogw deploy <game> <DEV|STG> <version>',
  background: { game: (args) => args.positionals[0] ?? null, timeLimitMs: () => LIMITS.jobMs },
  async run(ctx, args) {
    expectPositionals(args, 3, 3, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    const env = parseEnv(positional(args, 1, 'environment'));
    if (env === 'PROD') throw new OgwError('ogw deploy does not take PROD: a person deploys PROD');
    const version = positional(args, 2, 'version');
    const target = await loadDeployTarget(ctx, game, env, version);
    const steps = new Steps();
    const ssh = await openSsh(target.host, envSecret(ctx, target, 'deploySsh'), ctx.env);
    try {
      await deploySteps(ctx, target, ssh, steps);
    } finally {
      await ssh.close();
    }
    return {
      text: ['done', ...steps.log.map((s) => `${s.name}: ${s.status}`)].join('\n'),
      data: { result: 'done', steps: steps.log },
    };
  },
};
