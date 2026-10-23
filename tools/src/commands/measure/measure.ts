import { list, positional, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { collectMeasure, measureCollected, measureInstances, type MeasureResult } from './api.ts';

function report(result: MeasureResult): { text: string; data: unknown } {
  const lines = result.targets.map(
    (t) => `${t.metric}: ${t.value === null ? 'unknown' : String(t.value)} [${String(t.min)}, ${String(t.max)}] ${t.result}`,
  );
  lines.push(result.path);
  return { text: lines.join('\n'), data: { path: result.path, commit: result.commit, targets: result.targets } };
}

export const measureCommand: CommandDef = {
  name: ['measure'],
  usage:
    'ogw measure <game> <instance id>... | ogw measure <game> --collect <instance id> --out <file> | ogw measure <game> --collected <file>...',
  options: { collect: { type: 'string' }, out: { type: 'string' }, collected: { type: 'string', multiple: true } },
  async run(ctx, args) {
    const game = positional(args, 0, 'game');
    const ids = args.positionals.slice(1);
    const collect = str(args, 'collect');
    const out = str(args, 'out');
    const collected = list(args, 'collected');
    if (collect !== undefined) {
      if (out === undefined || ids.length > 0 || collected.length > 0) throw new OgwError(`usage: ${this.usage}`);
      await collectMeasure(ctx, game, collect, out);
      return { text: out, data: { out } };
    }
    if (out !== undefined) throw new OgwError('--out goes with --collect');
    if (collected.length > 0) {
      if (ids.length > 0) throw new OgwError(`usage: ${this.usage}`);
      return report(await measureCollected(ctx, game, collected));
    }
    if (ids.length === 0) throw new OgwError(`usage: ${this.usage}`);
    return report(await measureInstances(ctx, game, ids));
  },
};
