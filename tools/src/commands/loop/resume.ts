import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import type { GameRepo } from '../../lib/game.ts';
import { git, revParse, showFile, statusLines, tagExists } from '../../lib/git.ts';
import { waitJob } from '../../lib/jobs.ts';
import { requireOpenRun, type RunState } from '../../lib/runstate.ts';
import { isBuildRunMerge } from '../build/lib/buildrun.ts';
import { buildTagName, parseEnv } from '../build/lib/names.ts';
import { listInstances, stopInstance } from '../instance/api.ts';
import { roleOf, runJobs } from './lib/jobs.ts';
import { mergeBranchMerged } from './lib/merge-branch.ts';
import { openTarget, runFileExists, runRel } from './lib/run.ts';
import { sync, syncText, WORKER_ROLES } from './lib/sync.ts';

const USAGE = 'ogw loop resume <game>';

/**
 * `build` `## procedure` resume rule: report committed → end, tag → 7, main HEAD is this run's `build finish` merge → 6,
 * PROD → 5, else 2.
 */
async function buildStep(ctx: Context, game: GameRepo, run: RunState): Promise<string> {
  const report = runRel(run, 'end.md');
  if ((await showFile(game.root, run.branch, report)) !== null || (await showFile(game.root, 'main', report)) !== null) return 'end';
  if (run.env !== null && run.version !== null && (await tagExists(game.root, buildTagName(parseEnv(run.env), run.version)))) return '7';
  if (run.env === 'PROD') return '5';
  const main = await revParse(game.root, 'main', { env: ctx.env });
  if (main !== null && (await isBuildRunMerge(game.root, run, main, ctx.env))) return '6';
  return '2';
}

function loopStep(game: GameRepo, run: RunState): string {
  const n = run.iteration;
  if (n === 0) return 'start 2';
  if (runFileExists(game, run, `iteration-${String(n)}.md`)) return `iteration ${String(n)} 8`;
  if (runFileExists(game, run, `content-${String(n)}.md`)) return `iteration ${String(n)} 2`;
  return `iteration ${String(n)} 1`;
}

async function checkoutRunBranch(game: GameRepo, run: RunState): Promise<string[]> {
  const notes: string[] = [];
  if ((await statusLines(game.root)).length > 0) {
    await git(game.root, ['stash', 'push', '--include-untracked', '--quiet', '-m', `ogw loop resume ${run.name}`]);
    notes.push('stashed uncommitted changes');
  }
  await git(game.root, ['checkout', '--quiet', run.branch]);
  notes.push(`checked out ${run.branch}`);
  return notes;
}

async function waitOtherJobs(ctx: Context, game: GameRepo, run: RunState): Promise<string[]> {
  const timeout = (await ctx.settings()).jobWaitTimeoutMs;
  const waited: string[] = [];
  for (const job of await runJobs(ctx, game, run)) {
    if (job.status !== 'running' || job.id === ctx.jobId || (WORKER_ROLES as readonly string[]).includes(roleOf(job) ?? '')) continue;
    const result = await waitJob(job.id, timeout, ctx.env);
    if (!result.finished) throw new OgwError(`job ${job.id} is still running; run ogw loop resume again`, 1, { job: job.id });
    waited.push(`waited for job ${job.id}`);
  }
  return waited;
}

export const loopResume: CommandDef = {
  name: ['loop', 'resume'],
  usage: USAGE,
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const { game, run } = await openTarget(ctx, positional(args, 0, 'game'));
    if (run.kind === 'loop' && (await mergeBranchMerged(game, run, ctx.env))) {
      return { text: 'resume at: end 5', data: { at: 'end 5' } };
    }
    // Jobs first: a running content agent or check job works in this checkout, so it is not stashed under them.
    const lines = await waitOtherJobs(ctx, game, run);
    lines.push(...(await checkoutRunBranch(game, run)));
    for (const instance of await listInstances(ctx, { game: game.name })) {
      await stopInstance(ctx, instance.id);
      lines.push(`stopped instance ${instance.id}`);
    }
    lines.push(syncText(await sync(ctx, game, false)));
    const current = await requireOpenRun(game);
    const at = current.kind === 'build' ? `build ${await buildStep(ctx, game, current)}` : loopStep(game, current);
    lines.push(`resume at: ${at}`);
    return { text: lines.join('\n'), data: { at } };
  },
};
