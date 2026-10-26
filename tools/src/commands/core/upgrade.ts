import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expectPositionals, flag, positional, str, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { readJson, writeFileAtomic, writeJsonAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { commitPaths, listTags } from '../../lib/git.ts';
import { LIMITS } from '../../lib/limits.ts';
import { changeOpenRun, openRun } from '../../lib/runstate.ts';
import { gameSettingsPath, withGameSettingsLock, type GameSettings } from '../../lib/settings.ts';
import { installEngines } from '../env/api.ts';
import { lastProdTagName } from '../build/lib/names.ts';
import { callContractTool, contractPrevious, type ContractRun } from '../contract/api.ts';
import { generateCheckout } from '../generate/api.ts';
import { CORE_UPGRADE_KEY } from '../loop/lib/api.ts';
import { fetchCoreRelease, gameCoreVersion, publishedRelease, releasedProposals, remoteReleaseVersions } from './api.ts';
import { compareSubjects } from './lib/github.ts';
import { releaseTag } from './lib/version.ts';
import { changedPaths } from './lib/gitx.ts';
import { workingFiles } from './lib/impl.ts';
import { compareVersions } from './lib/version.ts';
import { newPrivateTempFolder } from '../../lib/secret-files.ts';
import { harnessCoreVersion } from './lib/harness-core.ts';

/** What `ogw core upgrade` records in the open loop run: `run.data[CORE_UPGRADE_KEY]`. */
export interface CoreUpgradeRecord {
  /** The version `coreVersion` was changed to. */
  version: string;
  /** Higher versions left out because they break backward compatibility with the last PROD build. */
  skipped: string[];
}

/** What the contract tool reads of a game (`contract` skill `tool.md` `--game`): `contract/`, the data proto, the client core folder. */
const CONTRACT_INPUTS = ['contract/', 'server/generated/data/game_data.proto', 'client/core/'];

/** Copies the game files the contract tool reads into `dir`, so that its generation does not touch the checkout. */
async function gameCopy(game: GameRepo, dir: string): Promise<void> {
  await mkdir(join(dir, 'contract'), { recursive: true });
  for (const rel of CONTRACT_INPUTS) {
    for (const file of await workingFiles(game.root, rel)) {
      const target = join(dir, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(game.root, file), target);
    }
  }
}

/** The last PROD build as the contract tool compares it: the `--previous` folder and a copy of the game. */
interface Comparison {
  tag: string;
  previous: string;
  game: string;
}

function failed(version: string, run: ContractRun): OgwError {
  return new OgwError(`contract tool of core ${version} failed (${String(run.exitCode)}): ${run.stderr.trim()}`);
}

/**
 * True when `version`'s contract tool finds the game contract and base proto compatible with the last PROD build.
 * Backward compatibility violations are the violation lines that only the run with `--previous` prints; a version
 * with other violations alone is compatible (`tools/ogw.md` `## core upgrade`).
 */
async function compatibleWith(ctx: Context, version: string, settings: GameSettings, cmp: Comparison): Promise<boolean> {
  const release = await publishedRelease(ctx, version);
  const withPrevious = await callContractTool(ctx, { gameDir: cmp.game, settings, release, previous: cmp.previous });
  if (withPrevious.exitCode === 0) return true;
  if (withPrevious.exitCode !== 1) throw failed(version, withPrevious);
  const alone = await callContractTool(ctx, { gameDir: cmp.game, settings, release, previous: null });
  if (alone.exitCode !== 0 && alone.exitCode !== 1) throw failed(version, alone);
  const other = new Set(alone.violations);
  const breaking = withPrevious.violations.filter((line) => !other.has(line));
  if (breaking.length === 0) {
    ctx.log(`core ${version} keeps backward compatibility with ${cmp.tag}; its contract tool finds other violations:\n${alone.violations.join('\n')}`);
    return true;
  }
  ctx.log(`core ${version} breaks backward compatibility with ${cmp.tag}:\n${breaking.join('\n')}`);
  return false;
}

interface Choice {
  version: string | null;
  skipped: string[];
}

async function chooseVersion(ctx: Context, game: GameRepo, current: string, settings: GameSettings): Promise<Choice> {
  // no higher than the core whose specs this harness holds (AGENTS.md `## repo`)
  const harness = await harnessCoreVersion(ctx);
  const min = (await ctx.settings()).minCoreVersion;
  const supported = (version: string): boolean =>
    (harness === null || compareVersions(version, harness) <= 0) && (min === null || compareVersions(version, min) >= 0);
  const higher = (await remoteReleaseVersions(ctx)).filter((version) => compareVersions(version, current) > 0 && supported(version)).reverse();
  const tag = lastProdTagName(await listTags(game.root, { env: ctx.env }));
  if (tag === null || higher.length === 0) return { version: higher[0] ?? null, skipped: [] };
  const work = await newPrivateTempFolder('ogw-core-upgrade-', ctx.env);
  try {
    const cmp: Comparison = { tag, previous: join(work, 'previous'), game: join(work, 'game') };
    await contractPrevious(ctx, game, tag, cmp.previous);
    await gameCopy(game, cmp.game);
    const skipped: string[] = [];
    for (const version of higher) {
      if (await compatibleWith(ctx, version, settings, cmp)) return { version, skipped };
      skipped.push(version);
    }
    return { version: null, skipped };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Fetches the release, changes `coreVersion`, installs engines, generates, and commits `settings.json` with the files
 * `ogw generate` wrote or removed. When a step after the `settings.json` write fails, `settings.json` gets its
 * committed content back and `ogw generate` runs again with it.
 */
async function applyVersion(ctx: Context, game: GameRepo, from: string, version: string): Promise<string | null> {
  if ((await changedPaths(game.root)).has('settings.json')) throw new OgwError('settings.json has uncommitted changes; commit or revert them first');
  await fetchCoreRelease(ctx, version);
  const path = gameSettingsPath(game.root);
  const original = await withGameSettingsLock(game.root, ctx.env, async () => {
    const bytes = await readFile(path);
    const raw = await readJson<Record<string, unknown>>(path);
    raw.coreVersion = version;
    await writeJsonAtomic(path, raw);
    return bytes;
  });
  let generating = false;
  try {
    await installEngines(ctx, game.name);
    generating = true;
    const applied = await generateCheckout(ctx, game);
    // git status leaves out ignored generated files, which git add would refuse.
    const changed = await changedPaths(game.root);
    const generated = [...new Set([...applied.written, ...applied.removed])].filter((p) => p !== 'settings.json' && changed.has(p));
    const paths = ['settings.json', ...generated.sort()];
    return await commitPaths(game.root, paths, `core upgrade: ${from} -> ${version}`, { env: ctx.env });
  } catch (error) {
    await withGameSettingsLock(game.root, ctx.env, () => writeFileAtomic(path, original));
    if (generating) {
      await generateCheckout(ctx, game).catch((restoreError: unknown) => {
        ctx.log(`ogw generate with core ${from} after the failed upgrade failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
      });
    }
    throw error;
  }
}

/** First lines of the commits `ogw` makes for agent records, review lists and releases: not changes of core. */
const TOOL_COMMITS = /^(?:ogw agent |ogw: review lists |core release )/;

/**
 * `ogw core upgrade <game> --check`: what an upgrade would do, with the commit subjects of the core release repository
 * and the released core proposals of the game between the two versions. Changes nothing.
 */
async function check(ctx: Context, game: GameRepo, from: string, choice: Choice): Promise<{ text: string; data: Record<string, unknown> }> {
  const lines = [`coreVersion: ${from}`];
  if (choice.skipped.length > 0) lines.push(`skipped: ${choice.skipped.join(', ')}`);
  if (choice.version === null) {
    lines.push('no version to raise to');
    return { text: lines.join('\n'), data: { from, version: null, skipped: choice.skipped, changes: [], proposals: [] } };
  }
  const repo = (await ctx.settings()).coreReleaseRepository;
  const changes = (await compareSubjects(ctx, repo, releaseTag(from), releaseTag(choice.version))).filter((c) => !TOOL_COMMITS.test(c));
  const proposals = await releasedProposals(game, from, choice.version);
  lines.push(`would raise to: ${choice.version}`, `changes (${repo} ${releaseTag(from)}...${releaseTag(choice.version)}):`, ...changes.map((c) => `- ${c}`));
  lines.push(proposals.length > 0 ? `released core proposals: ${proposals.join(', ')}` : 'released core proposals: none');
  return { text: lines.join('\n'), data: { from, version: choice.version, skipped: choice.skipped, changes, proposals } };
}

/** `ogw core upgrade <game> (--check | --version <v>)` (`tools/ogw.md` `## core upgrade`). */
export const upgradeCommand: CommandDef = {
  name: ['core', 'upgrade'],
  usage: 'ogw core upgrade <game> (--check | --version <version>)',
  options: { check: { type: 'boolean' }, version: { type: 'string' } },
  background: {
    game: (args) => args.positionals[0] ?? null,
    timeLimitMs: () => LIMITS.jobMs,
  },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const approved = str(args, 'version');
    if (flag(args, 'check') === (approved !== undefined)) throw new OgwError(`give one of --check and --version\nusage: ${this.usage}`);
    const game = await ctx.game(positional(args, 0, 'game'));
    const from = await gameCoreVersion(game);
    const settings = JSON.parse(await readFile(gameSettingsPath(game.root), 'utf8')) as GameSettings;
    const choice = await chooseVersion(ctx, game, from, settings);
    if (approved === undefined) return check(ctx, game, from, choice);
    if (choice.version !== approved) {
      throw new OgwError(`--version ${approved} is not the version ogw core upgrade ${game.name} --check prints now (${choice.version ?? 'none'}); run --check again and ask the human`);
    }
    const commit = await applyVersion(ctx, game, from, approved);
    const run = await openRun(game);
    if (run?.kind === 'loop') {
      const record: CoreUpgradeRecord = { version: approved, skipped: choice.skipped };
      await changeOpenRun(game, (open) => {
        open.data[CORE_UPGRADE_KEY] = record;
      });
    }
    const lines = [`coreVersion: ${from} -> ${approved}`];
    if (choice.skipped.length > 0) lines.push(`skipped: ${choice.skipped.join(', ')}`);
    return { text: lines.join('\n'), data: { from, version: approved, skipped: choice.skipped, commit } };
  },
};
