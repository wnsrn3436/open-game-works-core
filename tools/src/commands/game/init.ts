import { mkdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, writeFileAtomic, writeJsonAtomic } from '../../lib/fsx.ts';
import { git, gitLine } from '../../lib/git.ts';
import { gameSettingsPath, schemaPath } from '../../lib/settings.ts';
import { remoteReleaseVersions } from '../core/api.ts';
import { deriveSettings } from './lib/derive.ts';
import { installHook } from './lib/pre-commit.ts';

const GAME_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Folders of a game repo (`AGENTS.md` `## repo`). */
const FOLDERS = ['contract', 'data', 'resource', 'client/dev', 'server/dev', 'records'];

/** The gameplay videos of `records/setup/reference/` are third-party works: every file there but `reference.md` stays out of git. */
const GITIGNORE = [
  '/builds/',
  '/client/build/',
  '/server/build/',
  '/captures/',
  '/records/loops/*/evidence/',
  '/records/setup/reference/*',
  '!/records/setup/reference/reference.md',
  '',
].join('\n');

/** Orphan branch `id-registry` whose only file is `id_registry.json` with `{}`. */
async function createIdRegistry(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  const blob = await gitLine(root, ['hash-object', '-w', '--stdin'], { input: '{}\n', env });
  const tree = await gitLine(root, ['mktree'], { input: `100644 blob ${blob}\tid_registry.json\n`, env });
  const commit = await gitLine(root, ['commit-tree', tree, '-m', 'id registry'], { env });
  await git(root, ['update-ref', 'refs/heads/id-registry', commit], { env });
}

async function draftSettings(ctx: Context, root: string): Promise<Record<string, unknown>> {
  // remoteReleaseVersions gives the `v<major>.<minor>.<patch>` release versions in ascending order.
  const coreVersion = (await remoteReleaseVersions(ctx)).at(-1);
  if (coreVersion === undefined) throw new OgwError(`no core release in ${(await ctx.settings()).coreReleaseRepository}`);
  const postgresqlMajor = Number((await ctx.settings()).tools.postgresql.tag.split('.')[0]);
  return deriveSettings({
    $schema: relative(root, schemaPath('game-settings', ctx.env)),
    coreVersion,
    postgresqlMajor,
  });
}

async function createRepo(ctx: Context, root: string, name: string, settings: Record<string, unknown>): Promise<string> {
  await mkdir(root, { recursive: true });
  await git(root, ['init', '--quiet', '--initial-branch', 'main'], { env: ctx.env });
  for (const folder of FOLDERS) await mkdir(join(root, folder), { recursive: true });
  await writeFileAtomic(join(root, '.gitignore'), GITIGNORE);
  await writeJsonAtomic(gameSettingsPath(root), settings);
  await createIdRegistry(root, ctx.env);
  return installHook(root, name, ctx.env);
}

export const init: CommandDef = {
  name: ['game', 'init'],
  usage: 'ogw game init <game>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const name = positional(args, 0, 'game');
    if (!GAME_NAME.test(name)) throw new OgwError(`game name is not kebab-case: ${name}`);
    const root = join((await ctx.workspace()).games, name);
    if (exists(root)) throw new OgwError(`game repo already exists: ${root}`);
    const settings = await draftSettings(ctx, root);
    try {
      const hook = await createRepo(ctx, root, name, settings);
      return {
        text: [`created ${root}`, `coreVersion ${String(settings.coreVersion)}`, `postgresqlMajor ${String(settings.postgresqlMajor)}`].join('\n'),
        data: { root, coreVersion: settings.coreVersion, postgresqlMajor: settings.postgresqlMajor, hook },
      };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  },
};
