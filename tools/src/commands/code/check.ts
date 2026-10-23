import { str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { LIMITS } from '../../lib/limits.ts';
import { codeCheck, formatItems } from './lib/run.ts';

export const check: CommandDef = {
  name: ['code', 'check'],
  usage: 'ogw code check <core|tool> [--commit <commit>] [--fix-base <commit> [--target <core target>]]',
  options: { commit: { type: 'string' }, 'fix-base': { type: 'string' }, target: { type: 'string' } },
  background: { timeLimitMs: () => LIMITS.jobMs },
  async run(ctx, args) {
    const [side, ...rest] = args.positionals;
    if ((side !== 'core' && side !== 'tool') || rest.length > 0) throw new OgwError(`usage: ${this.usage}`);
    const commit = str(args, 'commit');
    const fixBase = str(args, 'fix-base');
    const target = str(args, 'target');
    const checks = await codeCheck(ctx, side, {
      ...(commit === undefined ? {} : { commit }),
      ...(fixBase === undefined ? {} : { fixBase }),
      ...(target === undefined ? {} : { target }),
    });
    const failed = checks.some((c) => c.result === 'fail');
    return { exitCode: failed ? 1 : 0, text: formatItems(checks), data: { checks } };
  },
};
