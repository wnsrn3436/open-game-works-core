import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { writeFileAtomic, writeJsonAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { listTags, showFile } from '../../lib/git.ts';
import { loadGameSettings, type GameSettings } from '../../lib/settings.ts';
import { lastProdTagName } from '../build/lib/names.ts';
import { coreReleaseOfGame, extractedAsset, publishedRelease, type CoreRelease } from '../core/api.ts';
import { exportTree } from '../core/lib/gitx.ts';
import { mergeReleaseSettings, runGenerate, splitModules } from '../generate/api.ts';
import { readCoreSpec, usedModules } from '../generate/lib/core-spec.ts';
import { copyDir, runNodeTool, settingsAt, withTempDir } from '../data/lib/tool.ts';

export interface ContractRun {
  exitCode: number;
  /** stdout lines `<file>:<line>:<column> ERROR <message>`. */
  violations: string[];
  stderr: string;
}

const CONTRACT_BIN = 'bin/contract-tool.js';

/**
 * The `--previous` folder of the last `prod-<version>` tag: its `contract/` and `contract_version`, the base
 * proto of its core version, and that release's `core-settings.json` with the tag's game settings `core` over it.
 * The release is the published release of the tag's core version, also with harness settings `useLocalCore`.
 */
export async function contractPrevious(ctx: Context, game: GameRepo, tag: string, dir: string): Promise<void> {
  const rev = `refs/tags/${tag}^{commit}`;
  await mkdir(join(dir, 'contract'), { recursive: true });
  await exportTree(game.root, rev, 'contract', dir);
  const version = await showFile(game.root, rev, 'server/generated/contract/contract_version', { env: ctx.env });
  if (version === null) throw new OgwError(`no server/generated/contract/contract_version at ${tag}`);
  await writeFileAtomic(join(dir, 'contract_version'), version);
  const settings = await settingsAt(game.root, rev);
  if (typeof settings.coreVersion !== 'string') throw new OgwError(`no coreVersion in settings.json at ${tag}`);
  const release = await publishedRelease(ctx, settings.coreVersion);
  await copyDir(join(await extractedAsset(ctx, release, 'contract-tool.tgz'), 'proto'), join(dir, 'proto'));
  await writeJsonAtomic(join(dir, 'core-settings.json'), await mergeReleaseSettings(release.dir, settings.core));
}

/** One run of a release's contract tool (`skills/contract/tool.md` `## CLI`). */
export interface ContractToolCall {
  /** The `--game` folder; the tool runs in it. */
  gameDir: string;
  /** Game settings whose `engine`, `core` and `coreModules` the run uses. */
  settings: GameSettings;
  /** The release whose contract tool, base proto, `core-settings.json` and `core-spec.json` the run uses. */
  release: CoreRelease;
  /** The `--previous` folder (`contractPrevious`), or null for none. */
  previous: string | null;
}

/** Runs the contract tool of `call.release` with the arguments the harness tool passes for a game. */
export async function callContractTool(ctx: Context, call: ContractToolCall): Promise<ContractRun> {
  const tool = await extractedAsset(ctx, call.release, 'contract-tool.tgz');
  const modules = splitModules(usedModules(await readCoreSpec(call.release.dir), call.settings));
  return withTempDir('ogw-contract-', ctx.env, async (tmp) => {
    const coreSettings = join(tmp, 'core-settings.json');
    const modulesFile = join(tmp, 'modules.json');
    await writeJsonAtomic(coreSettings, await mergeReleaseSettings(call.release.dir, call.settings.core));
    await writeJsonAtomic(modulesFile, [...modules.client, ...modules.server]);
    const args = ['--game', call.gameDir];
    if (typeof call.settings.engine === 'string') args.push('--engine', call.settings.engine);
    args.push('--base-proto', join(tool, 'proto'), '--core-settings', coreSettings, '--modules', modulesFile);
    if (call.previous !== null) args.push('--previous', call.previous);
    const result = await runNodeTool(tool, CONTRACT_BIN, args, call.gameDir, ctx.env);
    const violations = result.stdout.split('\n').filter((line) => line.trim() !== '');
    return { exitCode: result.exitCode, violations, stderr: result.stderr };
  });
}

/**
 * `ogw contract` on the checkout `game.root`: runs the contract tool of the game's core version.
 * `generate: false` skips the `ogw generate` it runs first (for callers that just ran it).
 */
export async function runContract(ctx: Context, game: GameRepo, options?: { generate?: boolean }): Promise<ContractRun> {
  if (options?.generate !== false) await runGenerate(ctx, game);
  const settings = await loadGameSettings(game.root);
  const release = await coreReleaseOfGame(ctx, game);
  const tag = lastProdTagName(await listTags(game.root, { env: ctx.env }));
  if (tag === null) return callContractTool(ctx, { gameDir: game.root, settings, release, previous: null });
  return withTempDir('ogw-contract-previous-', ctx.env, async (previous) => {
    await contractPrevious(ctx, game, tag, previous);
    return callContractTool(ctx, { gameDir: game.root, settings, release, previous });
  });
}
