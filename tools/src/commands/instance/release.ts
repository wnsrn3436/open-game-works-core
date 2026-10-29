import { agentContext } from '../../lib/agentctx.ts';
import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { readJson } from '../../lib/fsx.ts';
import { instanceIds } from '../agent/lib/play-input.ts';
import { requestRelease } from './lib/releases.ts';

/**
 * `ogw instance release`: a judge agent gives back an instance of its own input that it plays no more. The command
 * runs in the broker sandbox, which cannot stop instances: it leaves a request that `ogw loop evaluate` carries out.
 */
export const release: CommandDef = {
  name: ['instance', 'release'],
  usage: 'ogw instance release <id>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const id = positional(args, 0, 'instance id');
    const agent = await agentContext(ctx.env);
    if (agent?.meta.role !== 'judge') throw new OgwError('ogw instance release is run by a judge agent');
    const input = await readJson<Record<string, unknown>>(String(agent.meta.agentInput ?? agent.meta.input));
    if (!instanceIds('judge', input).includes(id)) throw new OgwError(`instance ${id} is not an instance of the input of this agent`);
    await requestRelease(ctx.env, agent.job.id, id);
    return { text: `released ${id}`, data: { id, released: true } };
  },
};
