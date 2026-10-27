import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { expectPositionals, positional, str, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { branchExists, git, revParse, statusLines } from '../../lib/git.ts';
import { changeRuns, newRunState, openRun, type RunState } from '../../lib/runstate.ts';
import type { GameSettings } from '../../lib/settings.ts';
import { adminCall } from '../admin/api.ts';
import { requireReference } from '../loop/lib/api.ts';
import { contractVersionAt, dataVersionsAt, withCommitCheckout } from './lib/atcommit.ts';
import { buildDir, gameSettingsAt, type BuildRunData } from './lib/buildrun.ts';
import { hostProblems, requireOperatorSecret } from './lib/host.ts';
import { settingsCheckInput } from './lib/inputs.ts';
import { buildBranch, buildTagName, buildTags, lastProdTag, parseEnv, runName, tagCommit, type BuildTag, type Env } from './lib/names.ts';
import { planDevStg, planProd, type BuildPlan } from './lib/plan.ts';
import { ghcrLogin, imageDigest } from './lib/registry.ts';
import { humanChecks } from './lib/settingschecks.ts';
import { buildStageMissingErrors } from '../settings/api.ts';
import { requireHarnessCore } from '../core/lib/harness-core.ts';
import { coreRelease } from '../core/api.ts';
import { nativePluginProblems, releaseModules } from './lib/native-plugins.ts';

export const PLATFORMS = ['android', 'ios', 'web', 'windows', 'macos', 'linux'];

async function preconditions(ctx: Context, game: GameRepo): Promise<void> {
  if ((await ctx.settings()).useLocalCore) throw new OgwError('harness settings useLocalCore is true');
  const run = await openRun(game);
  if (run) throw new OgwError(`open run: ${run.name}`, 1, { run: run.name });
  const changes = await statusLines(game.root, { env: ctx.env });
  if (changes.length > 0) throw new OgwError(`the checkout has changes:\n${changes.join('\n')}`, 1, { changes });
  // build step 4 runs the judge agents, which need every gameplay video; fail before hardening starts
  await requireReference(game);
}

function choosePlatforms(given: string[], settings: GameSettings): string[] {
  const platforms = given.length > 0 ? given : (settings.buildPlatforms ?? []);
  for (const platform of platforms) if (!PLATFORMS.includes(platform)) throw new OgwError(`invalid platform: ${platform}`);
  if (platforms.length === 0) throw new OgwError('no platform to build');
  return [...new Set(platforms)];
}

/**
 * DEV, STG: human checks on the main HEAD commit (`build` `## build-time check`), in a temporary worktree of it: the
 * run is not registered yet, so the shared checkout is not touched.
 */
async function runHumanChecks(ctx: Context, game: GameRepo, commit: string, env: Env, platforms: string[]): Promise<void> {
  const input = await withCommitCheckout(ctx, game, commit, (repo) => settingsCheckInput(ctx, repo, env, platforms));
  const { checks } = await humanChecks(input);
  const failed = checks.flatMap((c) => (c.human ? [c.human] : []));
  if (failed.length === 0) return;
  const text = failed.map((f) => `human check ${f.check}: ${f.targets.join(', ')}`).join('\n');
  throw new OgwError(text, 1, { human: failed });
}

/** STG, PROD: check `native plugin` of the build run (`build` `## build-time check`), before the hardening agents start. */
async function requireNativePlugins(ctx: Context, settings: GameSettings, env: Env, platforms: string[]): Promise<void> {
  if (env === 'DEV') return;
  const release = await coreRelease(ctx, String(settings.coreVersion));
  const plugins = await nativePluginProblems(ctx, release, settings, env, platforms, releaseModules(release, settings));
  if (plugins.length > 0) throw new OgwError(`check native plugin:\n${plugins.join('\n')}`, 1, { plugins });
}

async function bundleHasData(ctx: Context, game: GameRepo, env: Env, appVersion: string, commit: string): Promise<boolean> {
  const appCommit = await tagCommit(game.root, buildTagName(env, appVersion));
  const [build, app] = [await dataVersionsAt(ctx, game, commit), await dataVersionsAt(ctx, game, appCommit)];
  return build.client !== app.client || build.server !== app.server;
}

async function prodChecks(ctx: Context, game: GameRepo, settings: GameSettings, plan: BuildPlan, bundleFor: string | null, tags: BuildTag[]): Promise<void> {
  if (bundleFor === null || (await bundleHasData(ctx, game, 'PROD', bundleFor, plan.startCommit))) {
    const repository = (settings.serverImage as { repository: string }).repository;
    await ghcrLogin(ctx);
    if ((await imageDigest(ctx, `${repository}:stg-${plan.version}`)) === null) {
      throw new OgwError(`server image ${repository}:stg-${plan.version} is not in the registry`);
    }
  }
  const last = lastProdTag(tags);
  if (last === null) return;
  const current = await contractVersionAt(game.root, plan.startCommit);
  const previous = await contractVersionAt(game.root, await tagCommit(game.root, last.tag));
  if (current === null || previous === null || current <= previous) return;
  const missing = requireOperatorSecret(ctx, game.name, settings, 'PROD');
  if (missing) throw new OgwError(missing);
  await adminCall(ctx, game.name, { env: 'PROD' }, 'sample_user_ids', { count: 1 }).catch((error: unknown) => {
    throw new OgwError(`PROD admin operation sample_user_ids failed: ${(error as Error).message}`);
  });
}

async function makeBranch(game: GameRepo, env: Env, plan: BuildPlan, branch: string): Promise<void> {
  const stamp = String(Date.now());
  if (await branchExists(game.root, branch)) await git(game.root, ['branch', '-m', branch, `${branch}-failed-${stamp}`]);
  const dir = buildDir(game, env, plan.version);
  if (exists(dir)) await rename(dir, `${dir}-failed-${stamp}`);
  await git(game.root, ['checkout', '--quiet', '-b', branch, plan.startCommit]);
}

function mainMoved(from: string, to: string | null): OgwError {
  return new OgwError(`main moved from ${from} to ${String(to)} while the build started: run build start again`);
}

/**
 * Registers the run under the run file lock, which commands that commit to main hold. DEV and STG build from main
 * HEAD, so main must still be the planned start commit: otherwise the build branch could not merge back.
 */
async function registerRun(ctx: Context, game: GameRepo, env: Env, plan: BuildPlan, run: RunState): Promise<void> {
  await changeRuns(game, async (runs) => {
    const other = runs.find((r) => r.closedAt === null);
    if (other) throw new OgwError(`open run: ${other.name}`, 1, { run: other.name });
    if (env !== 'PROD') {
      const main = await revParse(game.root, 'main', { env: ctx.env });
      if (main !== plan.startCommit) throw mainMoved(plan.startCommit, main);
    }
    runs.push(run);
  });
}

async function mainHead(game: GameRepo): Promise<string> {
  const commit = await revParse(game.root, 'main');
  if (commit === null) throw new OgwError('branch main does not exist');
  return commit;
}

export const start: CommandDef = {
  name: ['build', 'start'],
  usage: 'ogw build start <game> <DEV|STG|PROD> [<platform>...] [--version <version>] [--bundle-for <app version>]',
  options: { version: { type: 'string' }, 'bundle-for': { type: 'string' } },
  async run(ctx, args) {
    expectPositionals(args, 2, 2 + PLATFORMS.length, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    const env = parseEnv(positional(args, 1, 'environment'));
    const versionArg = str(args, 'version');
    const bundleFor = str(args, 'bundle-for');
    if (bundleFor !== undefined && versionArg !== undefined) throw new OgwError('--bundle-for takes no --version');
    await preconditions(ctx, game);
    const tags = await buildTags(game.root);
    const input = { root: game.root, env, version: versionArg, bundleFor, tags };
    // PROD builds from the stg tag commit, DEV and STG from main HEAD; the settings are the ones of that commit.
    const prodPlan = env === 'PROD' ? await planProd(input) : null;
    const checked = prodPlan?.startCommit ?? (await mainHead(game));
    const settings = await gameSettingsAt(game.root, checked, ctx.env);
    // the hardening agents read the specs of this harness
    await requireHarnessCore(ctx, game.name, String(settings.coreVersion));
    const platforms = choosePlatforms(args.positionals.slice(2), settings);
    const missing = await buildStageMissingErrors(ctx, game.name, settings, env);
    if (missing.length > 0) throw new OgwError(`game settings miss build stage values (ogw game check ${game.name} --build):\n${missing.join('\n')}`, 1, { missing });
    const problems = await hostProblems(ctx, { game, env, platforms, settings, harness: await ctx.settings(), hasProdTag: lastProdTag(tags) !== null });
    if (problems.length > 0) throw new OgwError(problems.join('\n'), 1, { problems });
    await requireNativePlugins(ctx, settings, env, platforms);
    if (env !== 'PROD') await runHumanChecks(ctx, game, checked, env, platforms);
    const plan = prodPlan ?? (await planDevStg(input));
    if (plan.startCommit !== checked) throw mainMoved(checked, plan.startCommit);
    if (env === 'PROD') await prodChecks(ctx, game, settings, plan, bundleFor ?? null, tags);
    const name = runName(env, plan.version);
    const branch = buildBranch(env, plan.version);
    const data: BuildRunData = { retries: 0, bundle: plan.bundle, startCommit: plan.startCommit };
    await registerRun(ctx, game, env, plan, newRunState({ name, kind: 'build', branch, baseCommit: plan.startCommit, referenceCommit: plan.startCommit, env, version: plan.version, platforms, bundleFor: bundleFor ?? null, data: { build: data } }));
    try {
      await makeBranch(game, env, plan, branch);
    } catch (error) {
      await changeRuns(game, (runs) => {
        runs.splice(0, runs.length, ...runs.filter((r) => r.name !== name));
      });
      throw error;
    }
    await mkdir(join(game.root, 'records', 'loops', name), { recursive: true });
    const head = await revParse(game.root, 'HEAD', { env: ctx.env });
    return {
      text: `run ${name}\nversion ${plan.version}\nbranch ${branch}\ncommit ${String(head)}`,
      data: { run: name, version: plan.version, branch, commit: head, platforms },
    };
  },
};
