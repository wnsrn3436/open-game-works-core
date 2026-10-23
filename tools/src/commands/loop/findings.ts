import { expectPositionals, flag, positional, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { writeJsonAtomic } from '../../lib/fsx.ts';
import { collectHardeningFindings, iterationFindings } from './lib/findings.ts';
import { abs, openTarget, runRel } from './lib/run.ts';

const USAGE = 'ogw loop findings <game> [--hardening]';

export const loopFindings: CommandDef = {
  name: ['loop', 'findings'],
  usage: USAGE,
  options: { hardening: { type: 'boolean' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const { game, run } = await openTarget(ctx, positional(args, 0, 'game'));
    let rel: string;
    let file;
    if (flag(args, 'hardening')) {
      if (run.kind !== 'build') throw new OgwError('--hardening is taken only in a build run');
      const collected = await collectHardeningFindings(game, run);
      rel = runRel(run, `findings-hardening-${String(collected.round)}.json`);
      file = collected.file;
    } else {
      if (run.iteration === 0) throw new OgwError(`run ${run.name} has not started an iteration`);
      rel = runRel(run, `findings-${String(run.iteration)}.json`);
      file = await iterationFindings(game, run, run.iteration);
    }
    await writeJsonAtomic(abs(game, rel), file);
    return {
      text: `${rel}\nfindings: ${String(file.findings.length)}\ndiscarded: ${String(file.discarded.length)}`,
      data: { path: rel, findings: file.findings.length, discarded: file.discarded.length },
    };
  },
};
