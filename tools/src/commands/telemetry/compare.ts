import { resolve } from 'node:path';
import { expectPositionals, nonNegativeInt, positional, str, type CommandArgs, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { readText } from '../../lib/fsx.ts';
import { readTelemetry } from './api.ts';
import { compareTelemetry, failureIsNone, formatComparison, freeScenes } from './lib/compare.ts';
import { windowTelemetry, type Telemetry } from './lib/metrics.ts';

async function guideText(ctx: Context, file: string | undefined): Promise<string | null> {
  return file === undefined ? null : readText(resolve(ctx.cwd, file));
}

/** The window of one instance (`--from-a`/`--to-a` or `--from-b`/`--to-b`), or undefined when not given. */
function windowOption(args: CommandArgs, side: 'a' | 'b'): { from: number; to: number } | undefined {
  const from = nonNegativeInt(args, `from-${side}`);
  const to = nonNegativeInt(args, `to-${side}`);
  if (from === undefined && to === undefined) return undefined;
  if (from === undefined || to === undefined) throw new OgwError(`--from-${side} and --to-${side} go together`);
  return { from, to };
}

export const compare: CommandDef = {
  name: ['telemetry', 'compare'],
  usage:
    'ogw telemetry compare <instance A> <instance B> [--from-a <ms> --to-a <ms> --from-b <ms> --to-b <ms>] [--guide-a <file> --guide-b <file>]',
  options: {
    'from-a': { type: 'string' },
    'to-a': { type: 'string' },
    'from-b': { type: 'string' },
    'to-b': { type: 'string' },
    'guide-a': { type: 'string' },
    'guide-b': { type: 'string' },
  },
  async run(ctx, args) {
    expectPositionals(args, 2, 2, this.usage);
    const windowA = windowOption(args, 'a');
    const windowB = windowOption(args, 'b');
    if ((windowA === undefined) !== (windowB === undefined)) throw new OgwError('the windows of A and B go together');
    const guideA = await guideText(ctx, str(args, 'guide-a'));
    const guideB = await guideText(ctx, str(args, 'guide-b'));
    const noFailure = [guideA, guideB].some((guide) => guide !== null && failureIsNone(guide));
    const cut = (t: Telemetry, w: { from: number; to: number } | undefined): Telemetry => (w === undefined ? t : windowTelemetry(t, w.from, w.to));
    const a = cut(await readTelemetry(ctx, positional(args, 0, 'instance A')), windowA);
    const b = cut(await readTelemetry(ctx, positional(args, 1, 'instance B')), windowB);
    const free = (guide: string | null) => (guide === null ? null : freeScenes(guide));
    const elements = compareTelemetry(a, b, noFailure, free(guideA), free(guideB));
    return { text: formatComparison(elements), data: { elements } };
  },
};
