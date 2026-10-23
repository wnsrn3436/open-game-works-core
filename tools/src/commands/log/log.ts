import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { automationRequest } from '../instance/automation.ts';

/** LogCore log lines (`time`, `level`, `tag`, `message`, `stack_trace` joined by tabs) whose level is `error`. */
export function errorLines(files: unknown): string[] {
  if (!Array.isArray(files)) throw new OgwError('extract_logs did not return a list');
  const lines: string[] = [];
  for (const file of files) {
    const content = (file as { content?: unknown } | null)?.content;
    if (typeof content !== 'string') continue;
    for (const line of content.split('\n')) {
      if (line.split('\t')[1] === 'error') lines.push(line);
    }
  }
  return lines;
}

export const log: CommandDef = {
  name: ['log'],
  usage: 'ogw log <instance>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const response = await automationRequest(ctx, positional(args, 0, 'instance'), 'extract_logs', [], 'main', { access: 'play' });
    if (!response.ok) throw new OgwError(`extract_logs failed: ${JSON.stringify(response.result)}`);
    const lines = errorLines(response.result);
    return { text: lines.length === 0 ? 'no error log' : lines.join('\n'), data: { errors: lines } };
  },
};
