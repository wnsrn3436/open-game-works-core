import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { writeJsonAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { checkoutLock, isCheckout, listTags, worktreeRemove } from '../../lib/git.ts';
import { withLock } from '../../lib/lock.ts';
import { loadGameSettings, loadSchema, schemaPath, withDefaults, type GameSettings } from '../../lib/settings.ts';
import { coreReleaseOfGame, extractedAsset, publishedRelease, type CoreRelease } from '../core/api.ts';
import { runGenerate, splitModules } from '../generate/api.ts';
import { readCoreSpec, usedModules } from '../generate/lib/core-spec.ts';
import { binaryBuildAt, type CommitBuild } from './lib/binary-build.ts';
import { prodTagCandidates } from './lib/prod-tag.ts';
import { runNodeTool, withTempDir, type ToolRun } from './lib/tool.ts';

export interface DataLine {
  level: 'ERROR' | 'WARN';
  code: string;
  where: string;
  message: string;
  /** The line as the data tool printed it. */
  text: string;
}

export interface DataRun {
  exitCode: number;
  lines: DataLine[];
  stderr: string;
}

const DATA_BIN = 'bin/data-tool.js';
const LINE = /^(.+:\d+:\d+) (ERROR|WARN) (\S+) ?(.*)$/;

/** Data check lines `<file>:<line>:<column> <ERROR|WARN> <code> <message>` of the data tool stdout. */
export function parseDataLines(stdout: string): DataLine[] {
  const lines: DataLine[] = [];
  for (const text of stdout.split(/\r?\n/)) {
    const match = LINE.exec(text);
    if (!match) continue;
    lines.push({
      where: match[1] as string,
      level: match[2] as 'ERROR' | 'WARN',
      code: match[3] as string,
      message: match[4] as string,
      text,
    });
  }
  return lines;
}

/** File path of a data check line. */
export function lineFile(line: DataLine): string {
  return line.where.replace(/:\d+:\d+$/, '');
}

interface ToolInput {
  gameDir: string;
  settings: GameSettings;
  release: CoreRelease;
  toolDir: string;
  /** Folder for the argument files. */
  dir: string;
  binary: boolean;
  strict: boolean;
  previous: string | null;
  /** `--id-registry`: the `id_registry.json` of a folder that is not a git checkout (`data` skill `tool.md` `## ID registry`). */
  idRegistry: string | null;
}

/** Data tool arguments (`data` skill `tool.md` `## CLI`). */
export async function dataToolArgs(ctx: Context, input: ToolInput): Promise<string[]> {
  const { settings, release } = input;
  const schema = await loadSchema(schemaPath('game-settings', ctx.env));
  const settingsFile = join(input.dir, 'game-settings.json');
  const modulesFile = join(input.dir, 'modules.json');
  await mkdir(input.dir, { recursive: true });
  await writeJsonAtomic(settingsFile, withDefaults(schema, settings));
  const modules = splitModules(usedModules(await readCoreSpec(release.dir), settings));
  await writeJsonAtomic(modulesFile, [...modules.client, ...modules.server]);
  const args = ['--game', input.gameDir, '--engine', String(settings.engine), '--base-proto', join(input.toolDir, 'proto')];
  args.push('--game-settings', settingsFile, '--core-spec', join(release.dir, 'core-spec.json'), '--modules', modulesFile);
  if (input.binary) args.push('--binary');
  if (input.strict) args.push('--strict');
  if (input.previous !== null) args.push('--previous', input.previous);
  if (input.idRegistry !== null) args.push('--id-registry', input.idRegistry);
  return args;
}

/**
 * Runs the data tool holding the generate lock of the checkout: the data tool replaces generation target folders
 * that `ogw generate` and other data tool runs in the same checkout also write.
 */
async function runTool(ctx: Context, input: ToolInput): Promise<ToolRun> {
  const args = await dataToolArgs(ctx, input);
  return withLock(await checkoutLock(input.gameDir, 'ogw-generate.lock', { env: ctx.env }), () =>
    runNodeTool(input.toolDir, DATA_BIN, args, input.gameDir, ctx.env),
  );
}

/**
 * The binary-built worktree of the PROD data tag, or null without a PROD tag. A bundle patch tag is the
 * PROD data tag only when its Client or Server data version differs from its app version tag's. Each tag is built
 * at most once.
 */
async function prodDataBuild(ctx: Context, game: GameRepo, made: string[]): Promise<string | null> {
  const tags = await listTags(game.root, { env: ctx.env });
  const builds = new Map<string, CommitBuild>();
  const buildOf = async (tag: string): Promise<CommitBuild> => {
    let built = builds.get(tag);
    if (built === undefined) {
      built = await binaryBuildAt(ctx, game, `refs/tags/${tag}^{commit}`, tag, made);
      builds.set(tag, built);
    }
    return built;
  };
  for (const candidate of await prodTagCandidates(game.root, tags)) {
    const built = await buildOf(candidate.tag);
    if (candidate.appTag === null) return built.dir;
    if (!tags.includes(candidate.appTag)) throw new OgwError(`bundle patch tag ${candidate.tag} has no tag ${candidate.appTag}`);
    const app = await buildOf(candidate.appTag);
    if (built.versions.client !== app.versions.client || built.versions.server !== app.versions.server) return built.dir;
  }
  return null;
}

/** The published release of the checkout's game settings `coreVersion`. */
async function publishedReleaseOf(ctx: Context, game: GameRepo, settings: GameSettings): Promise<CoreRelease> {
  if (typeof settings.coreVersion !== 'string') throw new OgwError(`game settings of ${game.name} have no coreVersion`);
  return publishedRelease(ctx, settings.coreVersion);
}

/**
 * `ogw data` on the checkout `game.root`: runs the data tool of the game's core version.
 * `generate: false` skips the `ogw generate` that `ogw data` runs first (for `ogw check`, which does
 * not run `ogw generate` in its checkout, and for callers that just ran it). `prodCompare: false` skips the
 * comparison with the PROD data tag (no `--previous`): for reading the data versions of an older commit, and for a
 * checkout whose data the caller already compared. `published: true` takes the published release of the checkout's
 * core version, also with harness settings `useLocalCore` (for a commit's binary build, `binaryBuildAt`).
 */
export async function runData(
  ctx: Context,
  game: GameRepo,
  options?: { binary?: boolean; strict?: boolean; generate?: boolean; prodCompare?: boolean; published?: boolean },
): Promise<DataRun> {
  if (options?.generate !== false) await runGenerate(ctx, game);
  const settings = await loadGameSettings(game.root);
  const release = options?.published === true ? await publishedReleaseOf(ctx, game, settings) : await coreReleaseOfGame(ctx, game);
  const toolDir = await extractedAsset(ctx, release, 'data-tool.tgz');
  const made: string[] = [];
  try {
    const result = await withTempDir('ogw-data-', ctx.env, async (tmp) => {
      const checkout = isCheckout(game.root);
      const previous = options?.prodCompare !== false && checkout ? await prodDataBuild(ctx, game, made) : null;
      const binary = options?.binary === true;
      const strict = options?.strict === true;
      const idRegistry = checkout ? null : join(game.root, 'id_registry.json');
      return runTool(ctx, { gameDir: game.root, settings, release, toolDir, dir: join(tmp, 'current'), binary, strict, previous, idRegistry });
    });
    return { exitCode: result.exitCode, lines: parseDataLines(result.stdout), stderr: result.stderr };
  } finally {
    for (const dir of made) await worktreeRemove(game.root, dir, { env: ctx.env });
  }
}
