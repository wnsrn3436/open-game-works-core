import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expectPositionals, positional, str, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, readJsonIfExists, readText, writeFileAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { commitPaths, currentBranch, git, showFile, tagExists } from '../../lib/git.ts';
import { buildRunFile, gameSettingsWithDefaults, requireBuildRun, type BuildRunResult, type OpenBuildRun } from './lib/buildrun.ts';
import { renderSections, sectionText } from './lib/markdown.ts';
import { buildDirName, buildTagName, buildTags, mostRecentTagOn } from './lib/names.ts';
import { readProdOrders } from './lib/prodorder.ts';
import {
  addedCoreProposals,
  artifactsBody,
  checksBody,
  convertersBody,
  coreSchemaBody,
  deployJobBody,
  hardeningBody,
  humanBody,
  needsHuman,
  privacyBody,
  prodDeployBody,
  protocolChangeBody,
  serverImageBody,
} from './lib/report-sections.ts';

async function updateFiles(game: GameRepo, open: OpenBuildRun): Promise<string[]> {
  const rel = `builds/${buildDirName(open.env, open.version)}`;
  const files: string[] = [];
  for (const sub of ['patch', 'update']) {
    const dir = join(game.root, rel, sub);
    if (!exists(dir)) continue;
    for (const name of (await readdir(dir)).sort()) {
      if (name !== 'update.json' && name !== 'patch.json') files.push(`${rel}/${sub}/${name}`);
    }
  }
  return files;
}

/**
 * `## server image` of the PROD server running before this build: from the build report on main of the most recent
 * PROD build on main (bundle patch builds included, this build excluded) whose `## server image` is not `none`.
 */
async function previousServerImage(game: GameRepo, open: OpenBuildRun): Promise<string> {
  const own = buildTagName('PROD', open.version);
  let candidates = (await buildTags(game.root)).filter((t) => t.env === 'PROD' && t.tag !== own).map((t) => t.tag);
  for (;;) {
    const found = await mostRecentTagOn(game.root, 'main', candidates);
    if (found === null) return 'none';
    const text = (await showFile(game.root, 'main', `records/loops/build-${found.tag}/end.md`))?.toString('utf8');
    const image = text === undefined ? 'none' : sectionText(text, 'server image');
    if (image !== 'none' && image !== '') return image.replace(/\n/g, ' ');
    candidates = candidates.filter((tag) => tag !== found.tag);
  }
}

async function deployBody(ctx: Context, game: GameRepo, open: OpenBuildRun, result: BuildRunResult | null): Promise<string> {
  if (open.env !== 'PROD') return deployJobBody(game, open.run, ctx.env);
  return prodDeployBody(await readProdOrders(ctx.env), {
    version: open.version,
    result,
    noServerImage: open.data.bundle !== null && result?.serverImage == null,
    updateFiles: await updateFiles(game, open),
    updateJson: exists(join(game.root, 'builds', buildDirName(open.env, open.version), 'update', 'update.json')),
    previousServerImage: await previousServerImage(game, open),
  });
}

async function prodServerUrl(game: GameRepo, env: NodeJS.ProcessEnv): Promise<string | null> {
  const settings = await gameSettingsWithDefaults(game.root, env);
  const url = settings.environments?.PROD?.serverUrl;
  return typeof url === 'string' ? url : null;
}

async function readReason(ctx: Context, result: string, reason: string | undefined): Promise<string> {
  if (result !== 'done' && result !== 'stopped') throw new OgwError(`invalid --result: ${result} (done or stopped)`);
  if (result === 'stopped' && reason === undefined) throw new OgwError('--result stopped needs --reason <file>');
  if (result === 'done' && reason !== undefined) throw new OgwError('--result done takes no --reason');
  if (reason === undefined) return 'done';
  const text = await readText(resolve(ctx.cwd, reason));
  return `stopped\n\n${text.trim()}`;
}

export const report: CommandDef = {
  name: ['build', 'report'],
  usage: 'ogw build report <game> --result <done|stopped> [--reason <file>]',
  options: { result: { type: 'string' }, reason: { type: 'string' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    const open = await requireBuildRun(game);
    const resultValue = str(args, 'result');
    if (resultValue === undefined) throw new OgwError(`usage: ${this.usage}`);
    const resultBody = await readReason(ctx, resultValue, str(args, 'reason'));
    const { run, env, version } = open;
    const buildRun = await readJsonIfExists<BuildRunResult>(buildRunFile(game, env, version));
    const branch = run.branch;
    const body = renderSections([
      ['result', resultBody],
      ['protocol change', protocolChangeBody(buildRun)],
      ['compatibility base', buildRun?.compatibilityBase ?? 'none'],
      ['artifacts', artifactsBody(env, buildRun)],
      ['server image', serverImageBody(buildRun)],
      ['hardening', await hardeningBody(game, branch, env, version)],
      ['checks', await checksBody(game, branch, run.name, buildRun)],
      ['store privacy', await privacyBody(game, env, version, await prodServerUrl(game, ctx.env))],
      ['converters', convertersBody(buildRun)],
      ['core schema', coreSchemaBody(buildRun)],
      ['deploy', await deployBody(ctx, game, open, buildRun)],
      ['human', humanBody(buildRun, await needsHuman(game, branch, run.name), await addedCoreProposals(game, run.baseCommit, branch))],
    ]);
    const tagged = await tagExists(game.root, buildTagName(env, version), { env: ctx.env });
    const target = tagged ? 'main' : branch;
    if ((await currentBranch(game.root, { env: ctx.env })) !== target) await git(game.root, ['checkout', '--quiet', target], { env: ctx.env });
    const rel = `records/loops/${run.name}/end.md`;
    await writeFileAtomic(join(game.root, rel), body);
    const commit = await commitPaths(game.root, [rel], `build: report ${run.name}`, { env: ctx.env });
    return { text: `${rel}\n${body}`, data: { path: rel, branch: target, commit } };
  },
};
