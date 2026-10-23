import { expectPositionals, positional, str, type CommandArgs, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError, EXIT_STILL_RUNNING } from '../../lib/errors.ts';
import { waitJob } from '../../lib/jobs.ts';

/** `--timeout <ms>`, or harness settings `jobWaitTimeoutMs` when it is not given. */
export async function timeoutOption(ctx: Context, args: CommandArgs): Promise<number> {
  const given = str(args, 'timeout');
  if (given === undefined) return (await ctx.settings()).jobWaitTimeoutMs;
  const value = Number(given);
  if (!Number.isInteger(value) || value < 0) throw new OgwError(`invalid --timeout: ${given}`);
  return value;
}

export const wait: CommandDef = {
  name: ['job', 'wait'],
  usage: 'ogw job wait <id> [--timeout <ms>]',
  options: { timeout: { type: 'string' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const result = await waitJob(positional(args, 0, 'job id'), await timeoutOption(ctx, args), ctx.env);
    if (!result.finished) return { exitCode: EXIT_STILL_RUNNING, text: 'running', data: { status: 'running' } };
    if (result.stderr) ctx.log(result.stderr.replace(/\n$/, ''));
    const exitCode = result.job.exitCode ?? 1;
    return {
      exitCode,
      text: result.stdout,
      data: { status: result.job.status, exitCode, stdout: result.stdout, stderr: result.stderr },
    };
  },
};
