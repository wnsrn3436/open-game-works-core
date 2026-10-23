import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { endJobsOfAgent, killJob } from '../../lib/jobs.ts';
import { stopInstancesOfAgent } from '../instance/api.ts';
import { readAgentJob } from './lib/meta.ts';
import { outcomeOf } from './lib/outcome.ts';

/** `ogw agent stop <id>`: ends a `ogw agent` job, the jobs its agent started and the instances it started. */
export const stop: CommandDef = {
  name: ['agent', 'stop'],
  usage: 'ogw agent stop <id>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const id = positional(args, 0, 'job id');
    // fails on a job that is not an ogw agent job, before anything is stopped
    await readAgentJob(id, ctx.env);
    await killJob(id, ctx.env);
    await endJobsOfAgent(id, ctx.env);
    const instances = await stopInstancesOfAgent(ctx, id);
    const outcome = await outcomeOf(id, ctx.env);
    const lines = [`${id} ${outcome.status}`, ...instances.map((i) => `stopped instance ${i}`)];
    return { text: lines.join('\n'), data: { id, status: outcome.status, instances } };
  },
};
