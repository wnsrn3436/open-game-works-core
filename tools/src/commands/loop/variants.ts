import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { currentBranch, statusLines } from '../../lib/git.ts';
import { LIMITS } from '../../lib/limits.ts';
import { removeVariantLeftovers } from './lib/agent-worktrees.ts';
import { runBaseline } from './lib/baseline.ts';
import { failWhenContentRunning, runJobs } from './lib/jobs.ts';
import { abs, confirmOf, iterationKind, openTarget, runFileExists, runRel } from './lib/run.ts';
import { runVariants } from './lib/variants.ts';

const USAGE = 'ogw loop variants <game>';

export const loopVariants: CommandDef = {
  name: ['loop', 'variants'],
  usage: USAGE,
  background: {
    game: (args) => args.positionals[0] ?? null,
    timeLimitMs: () => LIMITS.jobMs,
  },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const { game, run } = await openTarget(ctx, positional(args, 0, 'game'), 'loop');
    const n = run.iteration;
    if (n === 0) throw new OgwError(`run ${run.name} has not started an iteration; run ogw loop next first`);
    if (iterationKind(run, n) !== 'fun' || confirmOf(run, n) !== null) throw new OgwError(`iteration ${String(n)} is not a fun iteration; call the content agent`);
    const settings = await ctx.settings();
    if (settings.loop.variants < 2) throw new OgwError(`harness settings loop.variants is ${String(settings.loop.variants)}; call the content agent`);
    if (!runFileExists(game, run, `content-input-${String(n)}.md`)) throw new OgwError(`${runRel(run, `content-input-${String(n)}.md`)} is missing; run ogw loop input ${game.name} content first`);
    if (runFileExists(game, run, `content-${String(n)}.md`)) throw new OgwError(`${runRel(run, `content-${String(n)}.md`)} exists: the content agent of iteration ${String(n)} has ended`);
    if ((await currentBranch(game.root, { env: ctx.env })) !== run.branch) throw new OgwError(`${game.root} is not on ${run.branch}`);
    const changed = (await statusLines(game.root, { env: ctx.env })).filter((line) => !line.startsWith('??'));
    if (changed.length > 0) throw new OgwError(`${game.root} has uncommitted changes:\n${changed.join('\n')}`);
    const jobs = await runJobs(ctx, game, run);
    failWhenContentRunning(jobs);
    // what an interrupted earlier `ogw loop variants` of the run left
    await removeVariantLeftovers(ctx, game, run, jobs);
    const result = await runVariants(ctx, game, run, settings, await runBaseline(game, run));
    const lines = [
      result.path,
      ...result.file.variants.map(
        (v) =>
          `variant ${String(v.k)} ${v.job} ${v.element} commit ${v.commit ?? 'none'} vs baseline ${v.vsBaseline ?? 'none'}${v.chosen ? ' chosen' : ''}${v.merge === null ? '' : ` not merged: ${v.merge}`}`,
      ),
    ];
    if (result.chosen === null) {
      const input = abs(game, runRel(run, `content-input-${String(n)}.md`));
      lines.push(
        result.retry === null
          ? `no variant was merged and no variant agent failed: call the content agent with ogw agent content --game ${game.name} --input ${input} --background`
          : `no variant was merged: the content agent failed; retry it with ogw agent retry ${result.retry} --background`,
      );
      return { exitCode: 1, text: lines.join('\n'), data: { path: result.path, ...result.file, retry: result.retry } };
    }
    return { text: lines.join('\n'), data: { path: result.path, ...result.file, chosen: result.chosen.k } };
  },
};
