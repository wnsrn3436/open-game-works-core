import { expectPositionals, positional, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { jobReport, runReport } from './lib/report.ts';
import { renderReport, reportData } from './lib/render.ts';

const USAGE = 'ogw time <job id> | ogw time <game> --run <run> [--iteration <n>]';

/** `--iteration`: an iteration number, 1 or more. */
function iterationOf(given: string | undefined): number | null {
  if (given === undefined) return null;
  const n = Number(given);
  if (!/^[1-9][0-9]*$/.test(given) || !Number.isSafeInteger(n)) throw new OgwError(`invalid --iteration: ${given}`);
  return n;
}

export const time: CommandDef = {
  name: ['time'],
  usage: USAGE,
  options: { run: { type: 'string' }, iteration: { type: 'string' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const run = str(args, 'run');
    const iteration = iterationOf(str(args, 'iteration'));
    if (run === undefined && iteration !== null) throw new OgwError(`--iteration needs --run; usage: ${USAGE}`);
    const first = positional(args, 0, 'job id');
    const report = run === undefined ? await jobReport(ctx, first) : await runReport(ctx, first, run, iteration);
    return { text: renderReport(report), data: reportData(report) };
  },
};
