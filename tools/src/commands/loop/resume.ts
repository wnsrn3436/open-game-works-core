import { expectPositionals, flag, positional, type CommandArgs, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import type { GameRepo } from '../../lib/game.ts';
import { git, revParse, showFile, statusLines, tagExists } from '../../lib/git.ts';
import { waitJob } from '../../lib/jobs.ts';
import { changeOpenRun, requireOpenRun, type RunState } from '../../lib/runstate.ts';
import { isBuildRunMerge } from '../build/lib/buildrun.ts';
import { buildTagName, parseEnv } from '../build/lib/names.ts';
import { gameCoreVersionAt } from '../core/api.ts';
import { requireHarnessCore } from '../core/lib/harness-core.ts';
import { listInstances, stopInstance } from '../instance/api.ts';
import { removeVariantLeftovers } from './lib/agent-worktrees.ts';
import { harnessHead, pinHarness, pinnedHarness, requirePinned } from './lib/harness-pin.ts';
import { givenLimits, LIMIT_OPTIONS, runLimits, setRunLimits } from './lib/run-limits.ts';
import { roleOf, runJobs } from './lib/jobs.ts';
import { mergeBranchMerged } from './lib/merge-branch.ts';
import { openTarget, runFileExists, runRel } from './lib/run.ts';
import { sync, syncText, WORKER_ROLES } from './lib/sync.ts';

const USAGE = 'ogw loop resume <game> [--limit <iterations>] [--until <unix ms>] [--repin]';

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

/**
 * Steps 2 and 3 of ogw.md `## loop resume`: fails, changing nothing, on a limit it refuses, a harness repo HEAD that is
 * not the pinned harness commit without `--repin`, or a repin for the current iteration to a harness whose core version
 * is not the game's; then repins and replaces the limits given.
 */
async function pinAndLimit(ctx: Context, game: GameRepo, run: RunState, args: CommandArgs): Promise<string[]> {
  if (run.kind === 'build' && (args.values.limit !== undefined || args.values.until !== undefined)) {
    throw new OgwError('--limit and --until are taken only in a loop run');
  }
  const given = givenLimits(args, Date.now());
  const harness = run.kind === 'loop' ? await harnessHead(ctx.env) : null;
  const repin = flag(args, 'repin');
  if (harness !== null && !repin) requirePinned(run, harness);
  // a repin counts for the iteration whose loop iteration record is written next
  const n = run.iteration;
  const recorded = n >= 1 && (await showFile(game.root, run.branch, runRel(run, `iteration-${String(n)}.md`))) !== null;
  const counts = n >= 1 && !recorded ? n : n + 1;
  // no `ogw loop next` checks the core version for the current iteration, whose content agent reads the specs of the new pin
  if (harness !== null && repin && counts === n && pinnedHarness(run) !== harness) {
    await requireHarnessCore(ctx, game.name, await gameCoreVersionAt(game, run.branch));
  }
  return changeOpenRun(game, (open) => {
    const notes: string[] = [];
    const pinned = pinnedHarness(open);
    if (harness !== null && repin) pinHarness(open, harness, counts);
    if (pinned !== null && pinnedHarness(open) !== pinned) notes.push(`harness: ${String(harness)} (repinned from ${pinned}), counts for iteration ${String(counts)}`);
    if (given.iterations !== undefined || given.until !== undefined) {
      setRunLimits(open, given);
      const limits = runLimits(open);
      notes.push(`limits: --limit ${limits.iterations === null ? 'none' : String(limits.iterations)}, --until ${limits.until === null ? 'none' : String(limits.until)}`);
    }
    return notes;
  });
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
  options: { ...LIMIT_OPTIONS, repin: { type: 'boolean' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const { game, run } = await openTarget(ctx, positional(args, 0, 'game'));
    if (run.kind === 'loop' && (await mergeBranchMerged(game, run, ctx.env))) {
      return { text: 'resume at: end 5', data: { at: 'end 5' } };
    }
    const lines = await pinAndLimit(ctx, game, run, args);
    // Jobs first: a running content agent or check job works in this checkout, so it is not stashed under them.
    lines.push(...(await waitOtherJobs(ctx, game, run)));
    lines.push(...(await checkoutRunBranch(game, run)));
    for (const instance of await listInstances(ctx, { game: game.name })) {
      await stopInstance(ctx, instance.id);
      lines.push(`stopped instance ${instance.id}`);
    }
    // an interrupted `ogw loop variants` leaves the worktrees of its variant agents; it runs again from step 1
    const leftovers = await removeVariantLeftovers(ctx, game, run, await runJobs(ctx, game, run));
    lines.push(...leftovers.removed.map((what) => `removed ${what}`), ...leftovers.notRemoved.map((l) => `not removed ${l.what}: ${l.error}`));
    lines.push(syncText(await sync(ctx, game, false)));
    const current = await requireOpenRun(game);
    const at = current.kind === 'build' ? `build ${await buildStep(ctx, game, current)}` : loopStep(game, current);
    lines.push(`resume at: ${at}`);
    return { text: lines.join('\n'), data: { at } };
  },
};
