import { expectPositionals, flag, list, positional, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { LIMITS } from '../../lib/limits.ts';
import { runAgentJob } from './lib/launch.ts';
import { agentWait } from './lib/outcome.ts';
import { startAgent } from './lib/prepare.ts';

export const agent: CommandDef = {
  name: ['agent'],
  usage: 'ogw agent <role> [--game <game>] [--module <module>...] --input <file> [--background]',
  options: {
    game: { type: 'string' },
    module: { type: 'string', multiple: true },
    input: { type: 'string' },
    background: { type: 'boolean' },
  },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const input = str(args, 'input');
    if (input === undefined) throw new OgwError(`usage: ${this.usage}`);
    const game = str(args, 'game');
    const id = await startAgent(ctx, {
      role: positional(args, 0, 'role'),
      ...(game !== undefined ? { game } : {}),
      modules: list(args, 'module'),
      input,
    });
    if (flag(args, 'background')) return { text: id, data: { job: id } };
    return agentWait(id, LIMITS.jobMs, ctx.env);
  },
};

/** The background job of `ogw agent`. */
export const agentRun: CommandDef = {
  name: ['agent', '__run'],
  usage: 'ogw agent __run (internal: the job of ogw agent)',
  async run(ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    return runAgentJob(ctx);
  },
};
