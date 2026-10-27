import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { openRun } from '../../lib/runstate.ts';
import { listInstances } from '../instance/api.ts';
import { committedRecordPaths } from './lib/iteration-record.ts';
import { isAgentJob, roleOf, runJobs } from './lib/jobs.ts';
import { iterationKind, loopData } from './lib/run.ts';

const USAGE = 'ogw loop status <game>';

export const loopStatus: CommandDef = {
  name: ['loop', 'status'],
  usage: USAGE,
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const game = await ctx.game(positional(args, 0, 'game'));
    const run = await openRun(game);
    if (!run) return { text: 'none', data: { run: null } };
    const data = loopData(run);
    const lastRecord = (await committedRecordPaths(game, run, ctx.env)).at(-1) ?? null;
    const merged = new Set(data.merges.map((m) => m.job));
    const jobs = (await runJobs(ctx, game, run)).map((job) => ({
      id: job.id,
      command: roleOf(job) ?? job.command,
      status: job.status,
      merged: isAgentJob(job) ? merged.has(job.id) || job.meta.merged === true : null,
    }));
    const instances = (await listInstances(ctx, { game: game.name })).filter((i) => i.startedAt >= run.startedAt).map((i) => i.id);
    const tasks = data.tasks.map((t) => ({ role: t.role, input: t.input, retries: t.retries }));
    const gaveUp = data.tasks.filter((t) => t.gaveUp).map((t) => ({ input: t.input, lastFailure: t.lastFailure }));
    const iterationKindOf = run.iteration === 0 ? null : iterationKind(run, run.iteration);
    const lines = [
      `run: ${run.name}`,
      `kind: ${run.kind}`,
      `iteration: ${String(run.iteration)}`,
      `iteration kind: ${iterationKindOf ?? 'none'}`,
      `base commit: ${run.baseCommit}`,
      `last iteration record: ${lastRecord ?? 'none'}`,
      ...jobs.map((j) => `job ${j.id} ${j.command} ${j.status}${j.merged === null ? '' : j.merged ? ' merged' : ' not merged'}`),
      ...instances.map((id) => `instance ${id}`),
      ...tasks.map((t) => `task ${t.role} ${t.input} given again ${String(t.retries)}`),
      ...gaveUp.map((g) => `not given again ${g.input}: ${g.lastFailure ?? ''}`),
    ];
    return {
      text: lines.join('\n'),
      data: {
        run: run.name,
        kind: run.kind,
        iteration: run.iteration,
        iterationKind: iterationKindOf,
        baseCommit: run.baseCommit,
        lastRecord,
        jobs,
        instances,
        tasks,
        gaveUp,
      },
    };
  },
};
