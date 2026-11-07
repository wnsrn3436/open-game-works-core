import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { readJson, writeJsonAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { currentBranch, revParse, showFile } from '../../lib/git.ts';
import { startJob } from '../../lib/jobs.ts';
import { LIMITS } from '../../lib/limits.ts';
import { span } from '../../lib/spans.ts';
import { allSettledOrThrow } from '../../lib/pool.ts';
import type { GameSettings } from '../../lib/settings.ts';
import { readScenario } from '../check/lib/bot-playtest.ts';
import { coreRelease, coreReleaseOfGame } from '../core/api.ts';
import { runData, type DataRun } from '../data/api.ts';
import { gameModules } from '../generate/api.ts';
import { dataVersionsAt, protocolHash, readDataVersions, type DataVersions } from './lib/atcommit.ts';
import { addedConverters, convertersAt, convertersOf } from './lib/converters.ts';
import { buildDir, buildRunFile, gameSettingsWithDefaults, LATE_CHECKS, requireBuildRun, type BuildCheck, type BuildRunResult, type LateChecks, type OpenBuildRun } from './lib/buildrun.ts';
import { settingsCheckInput } from './lib/inputs.ts';
import { measureGate, withCheckWorkspaces, type CheckPlatform, type ClientCheckInput } from './lib/client-check.ts';
import { devicePerformance } from './lib/device-performance.ts';
import { webRunSettings, webSmoke } from './lib/web-smoke.ts';
import { repeatTest } from './lib/repeat-test.ts';
import { soakTest } from './lib/soak-test.ts';
import { buildTagName, buildTags, lastProdTag, tagCommit, type BuildTag } from './lib/names.ts';
import { nativePluginProblems } from './lib/native-plugins.ts';
import { buildBundle, buildPlatforms, type Artifact } from './lib/platform.ts';
import { writePrivacy } from './lib/privacy.ts';
import { compatibilityCheck, placeholderCheck, plain, staticChecks } from './lib/runchecks.ts';
import { DEV_ACCESS, needles, scanArtifacts, scanRepo } from './lib/secretscan.ts';
import { pushServerImage, serverImageDevCode, stgServerImage, warmServerImage, type ImageBuild, type ServerImage } from './lib/serverimage.ts';
import { blocksBuild, humanChecks, outcome, usedSpecModules, type CheckWithHuman, type SettingsCheckInput } from './lib/settingschecks.ts';
import { compatibleApps, writeUpdate } from './lib/update.ts';
import { matchWaitMs } from './lib/waittime.ts';

interface Build {
  ctx: Context;
  game: GameRepo;
  open: OpenBuildRun;
  settings: GameSettings;
  tags: BuildTag[];
  lastProd: BuildTag | null;
  outDir: string;
  platforms: string[];
}

const COMPAT_CODES = new Set(['protocol_change', 'prod_change']);

/**
 * The build's data check (`--strict`) and binary build. Versions are null when every ERROR line is a backward
 * compatibility error, which check `backward compatibility` reports; other errors stop the run with every line.
 */
async function dataBuild(ctx: Context, game: GameRepo): Promise<{ data: DataRun; versions: DataVersions | null }> {
  const data = await runData(ctx, game, { binary: true, strict: true });
  if (data.exitCode === 0) return { data, versions: await readDataVersions(game.root) };
  const errors = data.lines.filter((l) => l.level === 'ERROR');
  if (errors.length > 0 && errors.every((l) => COMPAT_CODES.has(l.code))) return { data, versions: null };
  throw new OgwError(`ogw data failed:\n${data.lines.map((l) => l.text).join('\n')}${data.stderr}`);
}

/** Adds failure lines to a check of the list and sets its result again. */
function addDetails(checks: readonly BuildCheck[], name: string, env: BuildRunResult['env'], lines: readonly string[]): void {
  const check = checks.find((c) => c.name === name);
  if (!check || lines.length === 0) return;
  check.details = [...check.details, ...lines];
  check.result = outcome(name, env, check.details);
}

async function bundleHasData(b: Build, versions: DataVersions | null): Promise<boolean> {
  const appVersion = b.open.run.bundleFor;
  if (appVersion === null) return true;
  if (versions === null) return true;
  const app = await dataVersionsAt(b.ctx, b.game, await tagCommit(b.game.root, buildTagName(b.open.env, appVersion)));
  return app.client !== versions.client || app.server !== versions.server;
}

/** The check workspaces the client checks of this build export from: those of a platform whose checks make an export. */
async function exportPlatforms(input: ClientCheckInput): Promise<CheckPlatform[]> {
  if (typeof (await readScenario(input.game.root)) === 'string') return [];
  const platforms: CheckPlatform[] = [];
  if (input.platforms.includes('android') && ((await input.ctx.settings()).testDevices ?? []).length > 0) platforms.push('android');
  if (input.platforms.includes('web') && typeof (await webRunSettings(input.ctx)) !== 'string') platforms.push('web');
  return platforms;
}

/**
 * The checks that a DEV web build leaves to the late checks job: `repeat test` and `soak test` only warn in a DEV build,
 * so the hand-off of its artifacts does not wait for them (ogw.md `## build run`).
 */
function lateCheckNames(b: Build): string[] {
  return b.open.env === 'DEV' && b.platforms.includes('web') ? [...LATE_CHECKS] : [];
}

/**
 * DEV: starts the late checks job `ogw build late` on the build commit, after the platform build and the push of the
 * server image, so that nothing else of the run loads the host while it runs.
 */
async function startLateChecks(b: Build, names: string[]): Promise<LateChecks> {
  const commit = await revParse(b.game.root, 'HEAD', { env: b.ctx.env });
  if (commit === null) throw new OgwError('the build branch has no commit');
  const job = await startJob({
    argv: ['build', 'late', b.game.name, '--commit', commit],
    cwd: b.ctx.cwd,
    command: 'build late',
    game: b.game.name,
    timeLimitMs: LIMITS.jobMs,
    agentJob: null,
    env: b.ctx.env,
  });
  return { names, job, commit };
}

/**
 * The client checks (ogw.md `## build run`). The check workspaces, and the check instances and exports of
 * `device performance` and `web smoke`, are made beside the other build-time checks (`load`). The checks that run the
 * game measure or judge times on the modelled device, so their runs start when all of that has ended: the runs of
 * `device performance` and `web smoke` together, `repeat test` when `web smoke` has ended, and `soak test` when
 * `repeat test` and `device performance` have ended.
 */
async function clientChecks(b: Build, load: readonly Promise<unknown>[]): Promise<{ checks: CheckWithHuman[]; loadingMs: number | null }> {
  const base: ClientCheckInput = {
    ctx: b.ctx, game: b.game, env: b.open.env, version: b.open.version, exportVersion: b.open.run.bundleFor ?? b.open.version, settings: b.settings, platforms: b.platforms,
  };
  return withCheckWorkspaces(base, async (workspaces) => {
    const input: ClientCheckInput = { ...base, workspaces };
    const preparing = (await exportPlatforms(input)).map((platform) => workspaces.prepare(platform));
    const deviceGate = measureGate();
    const webGate = measureGate();
    const device = span('device performance', () => devicePerformance(input, deviceGate.gate));
    const web = span('web smoke', () => webSmoke(input, webGate.gate));
    // a check workspace or an export that failed fails the check that uses it, not the build run
    const exported = [deviceGate.exportedOr(device), webGate.exportedOr(web)];
    const quiet = Promise.allSettled([...load, ...preparing, ...exported]).then(() => allSettledOrThrow(load));
    // a check that failed with an error stops the measurements too: once their instances stopped, the run fails with it
    const reason = await quiet.then(() => null, (error: unknown) => `a build-time check failed: ${(error as Error).message}`);
    deviceGate.open(reason);
    webGate.open(reason);
    if (reason !== null) {
      await Promise.allSettled([device, web]);
      await allSettledOrThrow(load);
    }
    // a DEV build runs them after the platform build, in the late checks job (`startLateChecks`)
    const late = lateCheckNames(b).length > 0;
    const repeat = late ? Promise.resolve(null) : web.then(() => span('repeat test', () => repeatTest(input)));
    const soak = late ? Promise.resolve(null) : Promise.allSettled([repeat, device]).then(() => allSettledOrThrow([repeat, device])).then(() => span('soak test', () => soakTest(input)));
    await allSettledOrThrow([device, web, repeat, soak]);
    const smoke = await web;
    const checks = [await device, smoke?.check, await repeat, await soak].filter((c): c is BuildCheck => c !== null && c !== undefined);
    return { checks: checks.map((check) => ({ check, human: null })), loadingMs: smoke?.loadingMs ?? null };
  });
}

interface PreBuild {
  checks: CheckWithHuman[];
  webSmokeLoadingMs: number | null;
  licenseWarnings: string[];
  input: SettingsCheckInput;
}

/** Check `backward compatibility` when a PROD tag exists. */
async function compatibility(b: Build, data: DataRun, versions: DataVersions | null): Promise<CheckWithHuman | null> {
  if (!b.lastProd) return null;
  const { ctx, game, open } = b;
  const withImage = open.env === 'PROD' && (await bundleHasData(b, versions));
  const repository = (b.settings.serverImage as { repository: string }).repository;
  return compatibilityCheck({
    ctx, game, env: open.env, settings: b.settings, lastProd: b.lastProd, data,
    stgImage: withImage ? `${repository}:stg-${open.version}` : null,
    compat: versions?.compat ?? '',
  });
}

/** STG: the `DEV code` failures of the server image; PROD uses the server image of the STG build, which this check covered. */
async function imageDevCode(b: Build, versions: DataVersions | null): Promise<string[]> {
  if (b.open.env !== 'STG' || versions === null || !(await bundleHasData(b, versions))) return [];
  return serverImageDevCode(b.ctx, { game: b.game, settings: b.settings, env: b.open.env, version: b.open.version, compat: versions.compat });
}

/**
 * The build-time checks before the platform build. None reads the result of another, so they run together (ogw.md
 * `## build run`); the client checks keep their measurements off the others.
 */
async function preBuildChecks(b: Build, data: DataRun, versions: DataVersions | null): Promise<PreBuild> {
  const { ctx, game, open } = b;
  const ws = await ctx.workspace();
  const list = needles(ctx, game.name, b.settings, open.env, ws.root);
  const input = span('settings check input', () => settingsCheckInput(ctx, game, open.env, b.platforms));
  const human = input.then((read) => span('human checks', () => humanChecks(read)));
  const statics = span('static checks', () => staticChecks(ctx, game, open.env));
  const plugins = span('native plugin', async () => nativePluginProblems(ctx, await coreReleaseOfGame(ctx, game), b.settings, open.env, b.platforms, async () => (await input).modules, game.name));
  const devImage = span('DEV code of the image', () => imageDevCode(b, versions));
  const secret = span('secret scan', () => scanRepo(game, list));
  const placeholder = span('placeholder', () => placeholderCheck(ctx, game, open.env));
  const compat = span('backward compatibility', () => compatibility(b, data, versions));
  const load = [input, human, statics, plugins, devImage, secret, placeholder, compat];
  const client = span('client checks', () => clientChecks(b, load));
  await allSettledOrThrow([...load, client]);
  const checks: CheckWithHuman[] = [...(await statics), ...(await human).checks];
  checks.push(plain('native plugin', open.env, await plugins));
  addDetails(checks.map((c) => c.check), 'DEV code', open.env, await devImage);
  checks.push(plain('secret', open.env, await secret));
  checks.push(await placeholder);
  checks.push(...(await client).checks);
  const compatCheck = await compat;
  if (compatCheck !== null) checks.push(compatCheck);
  return { checks, webSmokeLoadingMs: (await client).loadingMs, licenseWarnings: (await human).licenseWarnings, input: await input };
}

function emptyResult(b: Build): BuildRunResult {
  return {
    env: b.open.env,
    version: b.open.version,
    checks: [],
    human: [],
    licenseWarnings: [],
    webSmokeLoadingMs: null,
    protocolChange: null,
    serverDataVersions: null,
    compatibilityBase: b.lastProd?.tag ?? 'none',
    artifacts: [],
    serverImage: null,
    converters: null,
    coreSchema: null,
    matchWaitMs: null,
  };
}

async function coreSchemaVersion(ctx: Context, version: string | undefined): Promise<number | null> {
  if (version === undefined) return null;
  const release = await coreRelease(ctx, version);
  const manifest = await readJson<{ coreSchemaVersion?: number }>(join(release.dir, 'manifest.json'));
  return manifest.coreSchemaVersion ?? null;
}

/** game settings `coreVersion` at a commit. */
async function coreVersionAt(root: string, commit: string): Promise<string | undefined> {
  const bytes = await showFile(root, commit, 'settings.json');
  if (bytes === null) return undefined;
  const version = (JSON.parse(bytes.toString('utf8')) as { coreVersion?: unknown }).coreVersion;
  return typeof version === 'string' ? version : undefined;
}

/** PROD build: the converters added after the last PROD build and the two `coreSchemaVersion`. */
async function prodFacts(b: Build): Promise<Pick<BuildRunResult, 'converters' | 'coreSchema'>> {
  if (b.open.env !== 'PROD') return { converters: null, coreSchema: null };
  const current = await coreSchemaVersion(b.ctx, b.settings.coreVersion);
  if (!b.lastProd) return { converters: [], coreSchema: { last: null, current } };
  const commit = await tagCommit(b.game.root, b.lastProd.tag);
  return {
    converters: addedConverters(await convertersAt(b.game.root, commit), await convertersOf(b.game.root)),
    coreSchema: { last: await coreSchemaVersion(b.ctx, await coreVersionAt(b.game.root, commit)), current },
  };
}

/** What the server side of a build with data writes into its result, and the apps of `update/update.json`. */
interface ServerFacts {
  apps: string[];
  protocolChange: BuildRunResult['protocolChange'];
  matchWaitMs: number | null;
}

/**
 * The server side facts of a build with data: none reads an artifact, so they are found beside the platform build.
 * Null when `stopWhen` gave true (the artifact checks blocked the build) before they were all found.
 */
async function serverFacts(b: Build, versions: DataVersions, stopWhen: () => boolean): Promise<ServerFacts | null> {
  const { ctx, game, open } = b;
  const appVersion = open.run.bundleFor;
  const earlier = await compatibleApps(ctx, game, open.env, b.tags, versions, stopWhen);
  if (earlier === null || stopWhen()) return null;
  const apps = [...(appVersion === null ? [open.version] : []), ...earlier];
  if (!b.lastProd) return { apps: [...new Set(apps)], protocolChange: null, matchWaitMs: null };
  const commit = await tagCommit(game.root, b.lastProd.tag);
  const last = await dataVersionsAt(ctx, game, commit);
  const changed = protocolHash(last.client) !== protocolHash(versions.client);
  return {
    apps: [...new Set(apps)],
    protocolChange: changed ? { client_data_version: versions.clientForServer, compat_client_data_version: versions.compat } : null,
    matchWaitMs: await matchWaitMs(ctx, game, commit, (await gameModules(ctx, game)).server),
  };
}

/** The server image: PROD the `stg-<version>` image; DEV and STG push the image built beside the platform build. */
async function serverImage(b: Build, image: ImageBuild): Promise<ServerImage> {
  if (b.open.env === 'PROD') return stgServerImage(b.ctx, b.settings, b.open.version);
  return pushServerImage(b.ctx, image);
}

function summary(result: BuildRunResult): string {
  const lines = result.checks.map((c) => `check ${c.name}: ${c.result}${c.details.length > 0 ? `\n  ${c.details.join('\n  ')}` : ''}`);
  for (const name of result.lateChecks?.names ?? []) lines.push(`check ${name}: pending`);
  if (result.lateChecks) lines.push(`late checks job ${result.lateChecks.job}`);
  for (const h of result.human) lines.push(`human check ${h.check}: ${h.targets.join(', ')}`);
  for (const a of result.artifacts) lines.push(`artifact ${a.platform}: ${a.path}${a.freeSigning === undefined ? '' : ` free signing: ${a.freeSigning}`}`);
  if (result.serverImage) lines.push(`server image ${result.serverImage.name}:${result.serverImage.tag}@${result.serverImage.digest}`);
  lines.push(`compatibility base ${result.compatibilityBase}`);
  if (result.webSmokeLoadingMs !== null) lines.push(`web smoke first loading ms ${String(result.webSmokeLoadingMs)}`);
  if (result.protocolChange) lines.push(`protocol change ${result.protocolChange.client_data_version} ${result.protocolChange.compat_client_data_version}`);
  lines.push(`match wait ms ${String(result.matchWaitMs ?? 'none')}`);
  return lines.join('\n');
}

async function finishResult(b: Build, result: BuildRunResult, failed: boolean): Promise<{ exitCode: number; text: string; data: BuildRunResult }> {
  await writeJsonAtomic(buildRunFile(b.game, b.open.env, b.open.version), result);
  return { exitCode: failed ? 1 : 0, text: summary(result), data: result };
}

/** Platform builds, or the bundle of a bundle patch build (check `bundle`); client packages holding DEV code fail check `DEV code`. */
async function buildArtifacts(b: Build, result: BuildRunResult, withData: boolean, ios: { privacy: Parameters<typeof buildPlatforms>[1]['iosPrivacy']; file: string | null }): Promise<void> {
  const { ctx, game, open } = b;
  if (open.run.bundleFor !== null) {
    const failures = await buildBundle(ctx, { game, env: open.env, version: open.version, appVersion: open.run.bundleFor, settings: b.settings, outDir: b.outDir, withData });
    result.checks.push(plain('bundle', open.env, failures).check);
    return;
  }
  const built = await buildPlatforms(ctx, {
    game, env: open.env, version: open.version, platforms: b.platforms, settings: b.settings, outDir: b.outDir, iosPrivacy: ios.privacy, privacyManifest: ios.file,
  });
  const artifacts: Artifact[] = built.artifacts;
  result.artifacts = artifacts;
  addDetails(result.checks, 'DEV code', open.env, built.devCode);
}

async function runBuild(b: Build): Promise<{ exitCode: number; text: string; data: BuildRunResult }> {
  const { ctx, game, open } = b;
  const result = emptyResult(b);
  const { data, versions } = await span('data build', () => dataBuild(ctx, game));
  const pre = await span('build-time checks', () => preBuildChecks(b, data, versions));
  result.checks = pre.checks.map((c) => c.check);
  result.human = pre.checks.flatMap((c) => (c.human ? [c.human] : []));
  result.licenseWarnings = pre.licenseWarnings;
  result.webSmokeLoadingMs = pre.webSmokeLoadingMs;
  if (result.checks.some((c) => blocksBuild(c, open.env)) || versions === null) return finishResult(b, result, true);
  const privacy = await span('privacy', () => writePrivacy({ dir: join(b.outDir, 'privacy'), env: open.env, platforms: b.platforms, settings: b.settings, modules: usedSpecModules(pre.input) }));
  const withData = await bundleHasData(b, versions);
  const manifest = privacy.files.includes('PrivacyInfo.xcprivacy') ? join(b.outDir, 'privacy', 'PrivacyInfo.xcprivacy') : null;
  const ws = await ctx.workspace();
  const list = needles(ctx, game.name, b.settings, open.env, ws.root);
  // the DEV build info file holds the DEV `devAccess` value (`dev_access`)
  const allowed = open.env === 'DEV' ? [DEV_ACCESS] : [];
  // beside the platform build (ogw.md `## build run`): the server image build, the server side facts and the PROD facts;
  // only the push of the server image waits for the artifact checks
  const image: ImageBuild = { game, settings: b.settings, env: open.env, version: open.version, compat: versions.compat };
  const artifactsDone = { failed: false };
  const artifacts = span('artifacts', () => buildArtifacts(b, result, withData, { privacy: privacy.ios, file: manifest })).then(
    async () => {
      const leaks = await span('artifact secret scan', () => scanArtifacts(game.root, [...b.platforms.map((p) => join(b.outDir, p)), join(b.outDir, 'patch')], list, allowed));
      const secret = result.checks.find((c) => c.name === 'secret');
      if (secret && leaks.length > 0) Object.assign(secret, { result: 'fail', details: [...secret.details, ...leaks] });
      artifactsDone.failed = result.checks.some((c) => blocksBuild(c, open.env));
    },
    (error: unknown) => {
      artifactsDone.failed = true;
      throw error;
    },
  );
  // a build whose artifacts failed needs no image and no server side facts: the cache build and the app versions stop
  const stop = (): boolean => artifactsDone.failed;
  const warm = withData && open.env !== 'PROD' ? span('server image cache build', () => warmServerImage(ctx, image, stop)) : Promise.resolve(false);
  const facts = withData ? span('server facts', () => serverFacts(b, versions, stop)) : Promise.resolve(null);
  const prod = span('PROD facts', () => prodFacts(b));
  await Promise.allSettled([artifacts, warm, facts, prod]);
  await artifacts;
  // a build that the artifact checks block needs none of the work beside them, which ran only after them before
  if (result.checks.some((c) => blocksBuild(c, open.env))) return finishResult(b, result, true);
  await allSettledOrThrow([warm, facts, prod]);
  const server = await facts;
  if (withData) {
    // only a build that the artifact checks block stops them
    if (server === null) throw new OgwError('the server side facts stopped although the artifact checks passed');
    result.serverDataVersions = { client_data_version: versions.clientForServer, compat_client_data_version: versions.compat };
    result.serverImage = await span('server image', () => serverImage(b, image));
    await span('update file', () => writeUpdate(game.root, b.outDir, versions.client, server.apps));
    result.protocolChange = server.protocolChange;
    result.matchWaitMs = server.matchWaitMs;
  }
  Object.assign(result, await prod);
  // the hand-off waits for no late check: they start when this run has nothing else to do
  const late = lateCheckNames(b);
  if (late.length > 0) result.lateChecks = await span('late checks start', () => startLateChecks(b, late));
  return finishResult(b, result, false);
}

export const run: CommandDef = {
  name: ['build', 'run'],
  usage: 'ogw build run <game>',
  background: { game: (args) => args.positionals[0] ?? null, timeLimitMs: () => LIMITS.jobMs },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    const open = await requireBuildRun(game);
    const branch = await currentBranch(game.root, { env: ctx.env });
    if (branch !== open.run.branch) throw new OgwError(`the checkout is on ${String(branch)}, not the build branch ${open.run.branch}`);
    const tags = await buildTags(game.root);
    const outDir = buildDir(game, open.env, open.version);
    await mkdir(outDir, { recursive: true });
    // a result of an earlier attempt must not read as this run's when this run stops with an error
    for (const stale of ['privacy', 'update', 'build-run.json', 'late-checks.json']) await rm(join(outDir, stale), { recursive: true, force: true });
    const settings = await gameSettingsWithDefaults(game.root, ctx.env);
    const platforms = open.run.platforms;
    return runBuild({ ctx, game, open, settings, tags, lastProd: lastProdTag(tags), outDir, platforms });
  },
};
