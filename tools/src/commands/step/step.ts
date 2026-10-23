import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { automationRequest, botControl, type ClientRef } from '../instance/automation.ts';
import { readPlayAccess } from '../instance/lib/records.ts';

async function state(ctx: Context, id: string, client: ClientRef): Promise<Record<string, unknown>> {
  const response = await automationRequest(ctx, id, 'get_state', [], client, { access: 'play' });
  if (!response.ok) throw new OgwError(`${client}: get_state failed: ${JSON.stringify(response.result)}`);
  return (response.result ?? {}) as Record<string, unknown>;
}

/** Clients `step` goes to: only the client in a `Playing` step-mode match, else every client in step mode. */
export async function stepTargets(ctx: Context, id: string): Promise<ClientRef[]> {
  const main = await state(ctx, id, 'main');
  if (main.step_mode === true && main.match_state === 'Playing') return ['main'];
  const targets: ClientRef[] = main.step_mode === true ? ['main'] : [];
  for (const client of (await readPlayAccess(id, ctx.env)).clients.filter((c) => c !== 'main')) {
    if ((await state(ctx, id, client)).step_mode === true) targets.push(client);
  }
  return targets;
}

export const step: CommandDef = {
  name: ['step'],
  usage: 'ogw step <instance> <ms>',
  async run(ctx, args) {
    expectPositionals(args, 2, 2, this.usage);
    const id = positional(args, 0, 'instance');
    const ms = positional(args, 1, 'ms');
    if (!/^[0-9]+$/.test(ms) || Number(ms) < 1) throw new OgwError(`invalid ms: ${ms}`);
    const targets = await stepTargets(ctx, id);
    if (targets.length === 0) throw new OgwError('no client is in step mode');
    await botControl(ctx, id, 'stepping', { active: true });
    let results: { client: ClientRef; ok: boolean; result: unknown }[];
    try {
      results = await Promise.all(
        targets.map(async (client) => {
          const response = await automationRequest(ctx, id, 'step', [ms], client, { access: 'play' });
          return { client, ok: response.ok, result: response.result };
        }),
      );
    } finally {
      await botControl(ctx, id, 'stepping', { active: false });
    }
    const failed = results.filter((r) => !r.ok);
    const text = failed.length === 0 ? `stepped ${ms} ms: ${targets.join(', ')}` : failed.map((r) => `${r.client}: step failed: ${JSON.stringify(r.result)}`).join('\n');
    return { exitCode: failed.length === 0 ? 0 : 1, text, data: { steps: results } };
  },
};
