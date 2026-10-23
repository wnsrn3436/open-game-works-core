import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { revParse } from '../../lib/git.ts';
import { changeOpenRun } from '../../lib/runstate.ts';
import { gameSettings, loopData, openTarget } from './lib/run.ts';

const USAGE = 'ogw loop next <game>';

export const loopNext: CommandDef = {
  name: ['loop', 'next'],
  usage: USAGE,
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const { game, run } = await openTarget(ctx, positional(args, 0, 'game'));
    if ((await ctx.settings()).useLocalCore) {
      throw new OgwError('harness settings useLocalCore is true: loop iterations do not start while the local core is in use');
    }
    const limit = Number((await gameSettings(ctx, game)).loopIterationLimit);
    // Both checks read the run inside the run file lock, so concurrent calls cannot pass the limit or set the reference twice.
    const started = await changeOpenRun(game, async (open) => {
      if (open.kind === 'loop' && open.iteration >= limit) {
        throw new OgwError(`iteration ${String(open.iteration)} reached game settings loopIterationLimit ${String(limit)}`, 1, {
          iteration: open.iteration,
          limit,
        });
      }
      if (open.kind === 'loop' && open.iteration === 0) open.referenceCommit = await revParse(game.root, open.branch, { env: ctx.env });
      // After a `confirm` verdict the new iteration confirms the candidate iteration (`game-loop` `## stop`).
      const data = open.kind === 'loop' ? loopData(open) : null;
      const confirming = data !== null && data.verdict?.reason === 'confirm' && data.verdict.iteration === open.iteration;
      const candidate = confirming ? (data.confirms.find((c) => c.iteration === open.iteration)?.candidate ?? open.iteration) : null;
      open.iteration++;
      if (data !== null && candidate !== null) data.confirms.push({ iteration: open.iteration, candidate });
      return { iteration: open.iteration, confirms: candidate };
    });
    const { iteration, confirms } = started;
    const text = confirms === null ? `iteration ${String(iteration)}` : `iteration ${String(iteration)}\nconfirms iteration ${String(confirms)}`;
    return { text, data: { run: run.name, iteration, confirms } };
  },
};
