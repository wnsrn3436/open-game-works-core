import { agentContext } from '../../lib/agentctx.ts';
import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { readJson } from '../../lib/fsx.ts';
import { instanceIds } from '../agent/lib/play-input.ts';
import { stopInstance } from './api.ts';

/** `ogw instance release`: a play or judge agent stops an instance of its own input once it plays it no more. */
export const release: CommandDef = {
  name: ['instance', 'release'],
  usage: 'ogw instance release <id>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const id = positional(args, 0, 'instance id');
    const agent = await agentContext(ctx.env);
    const role = agent?.meta.role;
    if (!agent || (role !== 'play' && role !== 'judge')) throw new OgwError('ogw instance release is run by a play or judge agent');
    const input = await readJson<Record<string, unknown>>(String(agent.meta.agentInput ?? agent.meta.input));
    if (!instanceIds(role, input).includes(id)) throw new OgwError(`instance ${id} is not an instance of the input of this agent`);
    await stopInstance(ctx, id);
    return { text: `released ${id}`, data: { id, released: true } };
  },
};
