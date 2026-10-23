import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { recordSpecDebt } from '../review/lib/spec-debt.ts';
import { timeoutOption } from '../job/wait.ts';
import { agentWait } from './lib/outcome.ts';

export const wait: CommandDef = {
  name: ['agent', 'wait'],
  usage: 'ogw agent wait <id> [--timeout <ms>]',
  options: { timeout: { type: 'string' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const id = positional(args, 0, 'job id');
    const result = await agentWait(id, await timeoutOption(ctx, args), ctx.env);
    if ((result.data as { status?: string } | undefined)?.status !== 'done') return result;
    // a spec review's out of scope items and the debt items it found gone change the spec debt lists
    const debt = await recordSpecDebt(ctx, id);
    if (debt === null || debt.lines.length === 0) return result;
    return { ...result, ...(debt.error ? { exitCode: 1 } : {}), text: [result.text, ...debt.lines].join('\n') };
  },
};
