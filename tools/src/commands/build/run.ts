import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { readJson, writeJsonAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { currentBranch, showFile } from '../../lib/git.ts';
import { LIMITS } from '../../lib/limits.ts';
import type { GameSettings } from '../../lib/settings.ts';
import { coreRelease } from '../core/api.ts';
import { runData, type DataRun } from '../data/api.ts';
import { gameModules } from '../generate/api.ts';
import { dataVersionsAt, protocolHash, readDataVersions, type DataVersions } from './lib/atcommit.ts';
import { addedConverters, convertersAt, convertersOf } from './lib/converters.ts';
import { buildDir, buildRunFile, gameSettingsWithDefaults, requireBuildRun, type BuildCheck, type BuildRunResult, type OpenBuildRun } from './lib/buildrun.ts';
import { settingsCheckInput } from './lib/inputs.ts';
import { type ClientCheckInput } from './lib/client-check.ts';
import { devicePerformance } from './lib/device-performance.ts';
import { webSmoke } from './lib/web-smoke.ts';
import { buildTagName, buildTags, lastProdTag, tagCommit, type BuildTag } from './lib/names.ts';
import { buildBundle, buildPlatforms, type Artifact } from './lib/platform.ts';
import { writePrivacy } from './lib/privacy.ts';
import { compatibilityCheck, placeholderCheck, plain, staticChecks } from './lib/runchecks.ts';
import { DEV_ACCESS, needles, scanArtifacts, scanRepo } from './lib/secretscan.ts';
import { buildServerImage, serverImageDevCode, stgServerImage, type ServerImage } from './lib/serverimage.ts';
import { humanChecks, outcome, usedSpecModules, type CheckWithHuman, type SettingsCheckInput } from './lib/settingschecks.ts';
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

/** Check `device performance` and `web smoke`, at the same time. */
async function clientChecks(b: Build): Promise<{ checks: CheckWithHuman[]; loadingMs: number | null }> {
  const input: ClientCheckInput = {
    ctx: b.ctx, game: b.game, env: b.open.env, version: b.open.version, exportVersion: b.open.run.bundleFor ?? b.open.version, settings: b.settings, platforms: b.platforms,
  };
  const [device, web] = await Promise.all([devicePerformance(input), webSmoke(input)]);
  const checks: CheckWithHuman[] = [{ check: device, human: null }];
  if (web) checks.push({ check: web.check, human: null });
  return { checks, loadingMs: web?.loadingMs ?? null };
}

interface PreBuild {
  checks: CheckWithHuman[];
  webSmokeLoadingMs: number | null;
  licenseWarnings: string[];
  input: SettingsCheckInput;
}

async function preBuildChecks(b: Build, data: DataRun, versions: DataVersions | null): Promise<PreBuild> {
  const { ctx, game, open } = b;
  const input = await settingsCheckInput(ctx, game, open.env, b.platforms);
  const human = await humanChecks(input);
  const ws = await ctx.workspace();
  const list = needles(ctx, game.name, b.settings, open.env, ws.root);
  const checks: CheckWithHuman[] = [...(await staticChecks(ctx, game, open.env)), ...human.checks];
  // PROD uses the server image of the STG build, which this check covered
  if (open.env === 'STG' && versions !== null && (await bundleHasData(b, versions))) addDetails(checks.map((c) => c.check), 'DEV code', open.env, await serverImageDevCode(ctx, game, b.settings, open.env));
  checks.push(plain('secret', open.env, await scanRepo(game, list)));
  checks.push(await placeholderCheck(ctx, game, open.env));
  const client = await clientChecks(b);
  checks.push(...client.checks);
  if (b.lastProd) {
    const withImage = open.env === 'PROD' && (await bundleHasData(b, versions));
    const repository = (b.settings.serverImage as { repository: string }).repository;
    checks.push(
      await compatibilityCheck({
        ctx, game, env: open.env, settings: b.settings, lastProd: b.lastProd, data,
        stgImage: withImage ? `${repository}:stg-${open.version}` : null,
        compat: versions?.compat ?? '',
      }),
    );
  }
  return { checks, webSmokeLoadingMs: client.loadingMs, licenseWarnings: human.licenseWarnings, input };
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
async function prodFacts(b: Build, result: BuildRunResult): Promise<void> {
  if (b.open.env !== 'PROD') return;
  const current = await coreSchemaVersion(b.ctx, b.settings.coreVersion);
  if (!b.lastProd) {
    result.converters = [];
    result.coreSchema = { last: null, current };
    return;
  }
  const commit = await tagCommit(b.game.root, b.lastProd.tag);
  result.converters = addedConverters(await convertersAt(b.game.root, commit), await convertersOf(b.game.root));
  result.coreSchema = { last: await coreSchemaVersion(b.ctx, await coreVersionAt(b.game.root, commit)), current };
}

async function serverSide(b: Build, result: BuildRunResult, versions: DataVersions): Promise<void> {
  const { ctx, game, open } = b;
  const compat = versions.compat;
  result.serverDataVersions = { client_data_version: versions.clientForServer, compat_client_data_version: compat };
  let image: ServerImage;
  if (open.env === 'PROD') image = await stgServerImage(ctx, b.settings, open.version);
  else image = await buildServerImage(ctx, game, b.settings, open.env, open.version, compat);
  result.serverImage = image;
  const appVersion = open.run.bundleFor;
  const apps = [...(appVersion === null ? [open.version] : []), ...(await compatibleApps(ctx, game, open.env, b.tags, versions))];
  await writeUpdate(game.root, b.outDir, versions.client, [...new Set(apps)]);
  if (b.lastProd) {
    const last = await dataVersionsAt(ctx, game, await tagCommit(game.root, b.lastProd.tag));
    if (protocolHash(last.client) !== protocolHash(versions.client)) {
      result.protocolChange = { client_data_version: versions.clientForServer, compat_client_data_version: compat };
    }
    result.matchWaitMs = await matchWaitMs(ctx, game, await tagCommit(game.root, b.lastProd.tag), (await gameModules(ctx, game)).server);
  }
}

function summary(result: BuildRunResult): string {
  const lines = result.checks.map((c) => `check ${c.name}: ${c.result}${c.details.length > 0 ? `\n  ${c.details.join('\n  ')}` : ''}`);
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
  const { data, versions } = await dataBuild(ctx, game);
  const pre = await preBuildChecks(b, data, versions);
  result.checks = pre.checks.map((c) => c.check);
  result.human = pre.checks.flatMap((c) => (c.human ? [c.human] : []));
  result.licenseWarnings = pre.licenseWarnings;
  result.webSmokeLoadingMs = pre.webSmokeLoadingMs;
  if (result.checks.some((c) => c.result === 'fail') || versions === null) return finishResult(b, result, true);
  const privacy = await writePrivacy({ dir: join(b.outDir, 'privacy'), env: open.env, platforms: b.platforms, settings: b.settings, modules: usedSpecModules(pre.input) });
  const withData = await bundleHasData(b, versions);
  const manifest = privacy.files.includes('PrivacyInfo.xcprivacy') ? join(b.outDir, 'privacy', 'PrivacyInfo.xcprivacy') : null;
  await buildArtifacts(b, result, withData, { privacy: privacy.ios, file: manifest });
  const ws = await ctx.workspace();
  const list = needles(ctx, game.name, b.settings, open.env, ws.root);
  const secret = result.checks.find((c) => c.name === 'secret');
  // the DEV build info file holds the DEV `devAccess` value (`dev_access`)
  const allowed = open.env === 'DEV' ? [DEV_ACCESS] : [];
  const leaks = await scanArtifacts(game.root, [...b.platforms.map((p) => join(b.outDir, p)), join(b.outDir, 'patch')], list, allowed);
  if (secret && leaks.length > 0) Object.assign(secret, { result: 'fail', details: [...secret.details, ...leaks] });
  if (result.checks.some((c) => c.result === 'fail')) return finishResult(b, result, true);
  if (withData) await serverSide(b, result, versions);
  await prodFacts(b, result);
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
    for (const stale of ['privacy', 'update', 'build-run.json']) await rm(join(outDir, stale), { recursive: true, force: true });
    const settings = await gameSettingsWithDefaults(game.root, ctx.env);
    const platforms = open.run.platforms;
    return runBuild({ ctx, game, open, settings, tags, lastProd: lastProdTag(tags), outDir, platforms });
  },
};
