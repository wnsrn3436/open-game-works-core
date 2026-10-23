import { expectPositionals, type CommandDef } from '../../lib/command.ts';
import { LIMITS } from '../../lib/limits.ts';
import { installEnginesReport, installLineLabel } from './api.ts';

export const installEnginesCommand: CommandDef = {
  name: ['env', 'install-engines'],
  usage: 'ogw env install-engines',
  background: { timeLimitMs: () => LIMITS.jobMs },
  async run(ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    const lines = await installEnginesReport(ctx);
    const text = lines.map((l) => {
      const state = l.result.installed ? 'installed' : `failed: ${l.result.reason ?? 'failed'}`;
      const mismatches = l.result.mismatches.map((m) => `\n  differs: ${m.what} expected ${m.expected} actual ${m.actual}`).join('');
      return `${installLineLabel(l)} (${l.from}): ${state}${mismatches}`;
    });
    const failed = lines.some((l) => !l.result.installed);
    return {
      exitCode: failed ? 1 : 0,
      text: lines.length === 0 ? 'no engine.json found' : text.join('\n'),
      data: { items: lines },
    };
  },
};
