import { setTimeout as sleep } from 'node:timers/promises';
import { agentContext } from '../../lib/agentctx.ts';
import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { EXIT_STILL_RUNNING, OgwError } from '../../lib/errors.ts';
import { readJson, readJsonIfExists } from '../../lib/fsx.ts';
import { instanceIds } from '../agent/lib/play-input.ts';
import { playAccessPath } from './lib/records.ts';
import { unstartedReason } from './lib/unstarted.ts';

export const waitDeps = {
  /** How long one call waits before it asks to be called again. */
  waitMs: 60_000,
  pollMs: 1000,
};

/**
 * `ogw instance wait`: a judge agent waits until an instance of its input runs. `ogw loop evaluate` starts some
 * instances of a judge after the judge, as the judge gives back others (`game-loop` `## iteration` 3). The command runs
 * in the broker sandbox: it reads the play access file the instance writes once it runs, and the note
 * `ogw loop evaluate` leaves when it could not start the instance or the judge gave it back.
 */
export const wait: CommandDef = {
  name: ['instance', 'wait'],
  usage: 'ogw instance wait <id>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const id = positional(args, 0, 'instance id');
    const agent = await agentContext(ctx.env);
    if (agent?.meta.role !== 'judge') throw new OgwError('ogw instance wait is run by a judge agent');
    const input = await readJson<Record<string, unknown>>(String(agent.meta.agentInput ?? agent.meta.input));
    if (!instanceIds('judge', input).includes(id)) throw new OgwError(`instance ${id} is not an instance of the input of this agent`);
    const access = await playAccessPath(id, ctx.env);
    const until = Date.now() + waitDeps.waitMs;
    for (;;) {
      if ((await readJsonIfExists(access)) !== null) return { text: `ready ${id}`, data: { id, state: 'ready' } };
      const reason = await unstartedReason(ctx.env, agent.job.id, id);
      if (reason !== null) {
        return { exitCode: 1, text: `instance ${id} does not run: ${reason}`, data: { id, state: 'not running', reason } };
      }
      if (Date.now() >= until) {
        return { exitCode: EXIT_STILL_RUNNING, text: `instance ${id} is still starting: give back the instances you finished, then run ogw instance wait ${id} again`, data: { id, state: 'starting' } };
      }
      await sleep(waitDeps.pollMs);
    }
  },
};
