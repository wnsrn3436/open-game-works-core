import { agentContext, runningAgents } from '../../lib/agentctx.ts';
import { positional, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { automationRequest } from '../instance/automation.ts';
import { isRefusedByCommand } from '../instance/lib/qa.ts';

/** Instance ids of a play or judge agent job: the `instances` the agent group keeps in the job meta. */
function agentInstances(meta: Record<string, unknown>): string[] {
  const instances = meta.instances;
  return Array.isArray(instances) ? instances.filter((id): id is string => typeof id === 'string') : [];
}

/** Fails when ogw agent rules (ogw.md `## agent`) block `ogw command` for this caller or instance. */
export async function checkCommandAllowed(ctx: Context, instanceId: string): Promise<void> {
  // the play and judge refusal fails closed: a caller that cannot be told is not let through
  const caller = await agentContext(ctx.env);
  if (caller && (caller.meta.role === 'play' || caller.meta.role === 'judge')) {
    throw new OgwError(`ogw command is not for the ${caller.meta.role} agent`);
  }
  for (const { job, meta } of await runningAgents(ctx.env)) {
    if (meta.role !== 'play' && meta.role !== 'judge') continue;
    if (agentInstances(meta).includes(instanceId)) {
      throw new OgwError(`instance ${instanceId} is played by the running ${meta.role} agent ${job.id}`);
    }
  }
}

export const command: CommandDef = {
  name: ['command'],
  usage: 'ogw command <instance> <name> [<argument>...]',
  verbatimAfter: 2,
  async run(ctx, args) {
    const instanceId = positional(args, 0, 'instance');
    const name = positional(args, 1, 'command name');
    if (isRefusedByCommand(name)) throw new OgwError(`ogw command does not send ${name}`);
    await checkCommandAllowed(ctx, instanceId);
    // the full token: the play token the play and judge sandbox can read does not send setup commands
    const response = await automationRequest(ctx, instanceId, name, args.positionals.slice(2), 'main', { access: 'full' });
    const data = { ok: response.ok, result: response.result };
    return { exitCode: response.ok ? 0 : 1, text: JSON.stringify(data), data };
  },
};
