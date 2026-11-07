import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expectPositionals, positional, str, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, readJsonIfExists, readText, writeFileAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { commitPaths, currentBranch, git, showFile, tagExists } from '../../lib/git.ts';
import { JobNotFound, readJob } from '../../lib/jobs.ts';
import { buildRunFile, gameSettingsWithDefaults, lateChecksFile, requireBuildRun, type BuildCheck, type BuildRunResult, type LateChecks, type LateChecksResult, type OpenBuildRun } from './lib/buildrun.ts';
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
import { runTimeSection } from '../time/api.ts';

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

/** The build report of the run with `## result` `resultBody` and the results `late` of its late checks. */
async function reportBody(ctx: Context, game: GameRepo, open: OpenBuildRun, resultBody: string, late: readonly BuildCheck[]): Promise<string> {
  const { run, env, version } = open;
  const buildRun = await readJsonIfExists<BuildRunResult>(buildRunFile(game, env, version));
  const branch = run.branch;
  return renderSections([
    ['result', resultBody],
    ['protocol change', protocolChangeBody(buildRun)],
    ['compatibility base', buildRun?.compatibilityBase ?? 'none'],
    ['artifacts', artifactsBody(env, buildRun)],
    ['server image', serverImageBody(buildRun)],
    ['hardening', await hardeningBody(game, branch, env, version)],
    ['checks', await checksBody(game, branch, run.name, buildRun, late)],
    ['store privacy', await privacyBody(game, env, version, await prodServerUrl(game, ctx.env))],
    ['converters', convertersBody(buildRun)],
    ['core schema', coreSchemaBody(buildRun)],
    ['deploy', await deployBody(ctx, game, open, buildRun)],
    ['human', humanBody(buildRun, await needsHuman(game, branch, run.name), await addedCoreProposals(game, run.baseCommit, branch))],
    ['time', await runTimeSection(ctx.env, game, run, null)],
  ]);
}

/** The branch the build report goes to: main once tag `<env>-<version>` exists, the build branch before. */
async function reportTarget(ctx: Context, game: GameRepo, open: OpenBuildRun): Promise<string> {
  const tagged = await tagExists(game.root, buildTagName(open.env, open.version), { env: ctx.env });
  return tagged ? 'main' : open.run.branch;
}

async function commitReport(ctx: Context, game: GameRepo, open: OpenBuildRun, target: string, body: string, subject: string): Promise<{ text: string; data: unknown }> {
  if ((await currentBranch(game.root, { env: ctx.env })) !== target) await git(game.root, ['checkout', '--quiet', target], { env: ctx.env });
  const rel = `records/loops/${open.run.name}/end.md`;
  await writeFileAtomic(join(game.root, rel), body);
  const commit = await commitPaths(game.root, [rel], subject, { env: ctx.env });
  return { text: `${rel}\n${body}`, data: { path: rel, branch: target, commit } };
}

/**
 * The results of the late checks of a DEV build (ogw.md `## build report`): those of `late-checks.json`, or, when the
 * job ended without that file, `unknown` with the reason. Fails while the job runs.
 */
async function lateResults(ctx: Context, game: GameRepo, open: OpenBuildRun, late: LateChecks): Promise<BuildCheck[]> {
  const job = await readJob(late.job, ctx.env).catch((error: unknown) => {
    if (error instanceof JobNotFound) return null;
    throw error;
  });
  if (job?.status === 'running') throw new OgwError(`late checks job ${late.job} is still running: wait for it with ogw job wait ${late.job}`);
  const file = await readJsonIfExists<LateChecksResult>(lateChecksFile(game, open.env, open.version));
  const ended = job === null ? 'is not on this host' : `ended (${job.status}, exit code ${String(job.exitCode)})`;
  return late.names.map((name) => {
    const check = file?.commit === late.commit ? file.checks.find((c) => c.name === name) : undefined;
    return check ?? { name, result: 'unknown', details: [`${name} did not run: the late checks job ${late.job} ${ended} without its result`] };
  });
}

/** The results of the late checks that `late-checks.json` already holds for the commit of the run's late checks. */
async function writtenLate(game: GameRepo, open: OpenBuildRun): Promise<BuildCheck[]> {
  const late = (await readJsonIfExists<BuildRunResult>(buildRunFile(game, open.env, open.version)))?.lateChecks ?? null;
  const file = await readJsonIfExists<LateChecksResult>(lateChecksFile(game, open.env, open.version));
  return late !== null && file?.commit === late.commit ? file.checks : [];
}

/** `--late`: the results of the late checks into `## checks` of the build report the run committed. */
async function writeLate(ctx: Context, game: GameRepo, open: OpenBuildRun): Promise<{ text: string; data: unknown }> {
  const late = (await readJsonIfExists<BuildRunResult>(buildRunFile(game, open.env, open.version)))?.lateChecks ?? null;
  if (late === null) return { text: 'no late checks', data: { checks: [] } };
  const target = await reportTarget(ctx, game, open);
  const rel = `records/loops/${open.run.name}/end.md`;
  const committed = (await showFile(game.root, target, rel, { env: ctx.env }))?.toString('utf8');
  if (committed === undefined) throw new OgwError(`${target} has no ${rel}: run ogw build report first`);
  const checks = await lateResults(ctx, game, open, late);
  const body = await reportBody(ctx, game, open, sectionText(committed, 'result'), checks);
  const written = await commitReport(ctx, game, open, target, body, `build: late checks ${open.run.name}`);
  const lines = checks.map((c) => `check ${c.name}: ${c.result}${c.details.length > 0 ? `\n  ${c.details.join('\n  ')}` : ''}`);
  return { text: `${lines.join('\n')}\n${written.text}`, data: { checks, report: written.data } };
}

export const report: CommandDef = {
  name: ['build', 'report'],
  usage: 'ogw build report <game> (--result <done|stopped> [--reason <file>] | --late)',
  options: { result: { type: 'string' }, reason: { type: 'string' }, late: { type: 'boolean' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    const open = await requireBuildRun(game);
    const resultValue = str(args, 'result');
    if (args.values.late === true) {
      if (resultValue !== undefined || str(args, 'reason') !== undefined) throw new OgwError(`usage: ${this.usage}`);
      return writeLate(ctx, game, open);
    }
    if (resultValue === undefined) throw new OgwError(`usage: ${this.usage}`);
    const body = await reportBody(ctx, game, open, await readReason(ctx, resultValue, str(args, 'reason')), await writtenLate(game, open));
    return commitReport(ctx, game, open, await reportTarget(ctx, game, open), body, `build: report ${open.run.name}`);
  },
};
