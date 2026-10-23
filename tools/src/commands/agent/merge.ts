import { agentContext } from '../../lib/agentctx.ts';
import { backgroundCommandOf, startBackground } from '../../lib/cli.ts';
import { flag, list, type CommandArgs, type CommandDef, type CommandResult, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { waitJob } from '../../lib/jobs.ts';
import { LIMITS } from '../../lib/limits.ts';
import { mergeAgents, type MergeResult } from './lib/merge.ts';
import { readAgentJob } from './lib/meta.ts';
import { outcomeOf } from './lib/outcome.ts';

const USAGE = 'ogw agent merge <id>... [--when-done [--then <ogw command>]... --background]';

/** A `--then` value as the command and args of the job it starts. */
async function thenCommand(line: string): Promise<ReturnType<typeof backgroundCommandOf>> {
  const { commands } = await import('../index.ts');
  try {
    return backgroundCommandOf(commands, line.split(' ').filter((token) => token !== ''));
  } catch (error) {
    if (error instanceof OgwError) throw new OgwError(`invalid --then ${JSON.stringify(line)}: ${error.message}`);
    throw error;
  }
}

/** Refuses the ids and `--then` values before anything waits or merges. */
async function checkArgs(ctx: Context, args: CommandArgs): Promise<void> {
  if (args.positionals.length === 0) throw new OgwError(`usage: ${USAGE}`);
  if (!flag(args, 'when-done')) {
    if (list(args, 'then').length > 0) throw new OgwError(`--then needs --when-done; usage: ${USAGE}`);
    throw new OgwError(`--background needs --when-done; usage: ${USAGE}`);
  }
  for (const line of list(args, 'then')) {
    const { def, args: thenArgs, self } = await thenCommand(line);
    // the check `--background` runs before a job starts; a command that starts its job itself has none
    if (self) continue;
    try {
      await def.background?.validate?.(ctx, thenArgs);
    } catch (error) {
      if (error instanceof OgwError) throw new OgwError(`invalid --then ${JSON.stringify(line)}: ${error.message}`);
      throw error;
    }
  }
  // an id that is not an ogw agent job fails here instead of after the other jobs end
  for (const id of args.positionals) await readAgentJob(id, ctx.env);
}

function mergeLines(result: MergeResult): string[] {
  return [...result.merged.map((id) => `merged ${id}`), ...result.failed.map((f) => `not merged ${f.id}: ${f.reason}: ${f.detail}`)];
}

/** `--when-done`: waits for every job, merges them when all ended `done`, then starts the `--then` jobs in order. */
async function mergeWhenDone(ctx: Context, args: CommandArgs): Promise<CommandResult> {
  if (ctx.jobId === null) throw new OgwError(`--when-done runs only with --background; usage: ${USAGE}`);
  await checkArgs(ctx, args);
  const ids = args.positionals;
  const thens = list(args, 'then');
  for (const id of ids) await waitJob(id, Number.POSITIVE_INFINITY, ctx.env);
  const notDone: { id: string; status: string }[] = [];
  for (const id of ids) {
    const { status } = await outcomeOf(id, ctx.env);
    if (status !== 'done') notDone.push({ id, status });
  }
  if (notDone.length > 0) {
    return { exitCode: 1, text: notDone.map((job) => `not done ${job.id}: ${job.status}`).join('\n'), data: { notDone, merged: [], failed: [], then: [] } };
  }
  const result = await mergeAgents(ctx, ids);
  const lines = mergeLines(result);
  if (result.failed.length > 0) return { exitCode: 1, text: lines.join('\n'), data: { notDone, ...result, then: [] } };
  const agent = await agentContext(ctx.env);
  const then: { job: string; command: string }[] = [];
  for (const line of thens) {
    let job: string;
    try {
      const { def, args: thenArgs, self } = await thenCommand(line);
      const started = self ? await def.run(ctx, thenArgs) : await startBackground(ctx, def, thenArgs, agent);
      job = (started.data as { job: string }).job;
    } catch (error) {
      // the merge and the jobs already started stay reported; later --then commands do not start
      const message = (error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, ' ');
      lines.push(`then not started: ${line}: ${message}`);
      return { exitCode: 1, text: lines.join('\n'), data: { notDone, ...result, then, notStarted: { command: line, error: message } } };
    }
    then.push({ job, command: line });
    lines.push(`then ${job}: ${line}`);
  }
  return { text: lines.join('\n'), data: { notDone, ...result, then, notStarted: null } };
}

export const merge: CommandDef = {
  name: ['agent', 'merge'],
  usage: USAGE,
  options: { 'when-done': { type: 'boolean' }, then: { type: 'string', multiple: true } },
  background: {
    // the jobs it waits for end within their own time limit; the merge may then wait for a core test on main
    timeLimitMs: () => 2 * LIMITS.jobMs,
    validate: checkArgs,
  },
  async run(ctx, args) {
    if (args.positionals.length === 0) throw new OgwError(`usage: ${USAGE}`);
    if (flag(args, 'when-done')) return mergeWhenDone(ctx, args);
    if (list(args, 'then').length > 0) throw new OgwError(`--then needs --when-done; usage: ${USAGE}`);
    const result = await mergeAgents(ctx, args.positionals);
    return { exitCode: result.failed.length > 0 ? 1 : 0, text: mergeLines(result).join('\n'), data: result };
  },
};
