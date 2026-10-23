import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { automationRequest, botControl, type ClientRef } from '../instance/automation.ts';
import { readPlayAccess } from '../instance/lib/records.ts';

async function send(ctx: Context, id: string, client: ClientRef, command: string, args: string[]): Promise<void> {
  const response = await automationRequest(ctx, id, command, args, client, { access: 'play' });
  if (!response.ok) throw new OgwError(`${client}: ${command} failed: ${JSON.stringify(response.result)}`);
}

/** `ogw step-mode`: the client, the bot loops, then each opponent bot client. */
export async function setStepMode(ctx: Context, id: string, on: boolean): Promise<void> {
  const value = on ? 'on' : 'off';
  const opponents = (await readPlayAccess(id, ctx.env)).clients.filter((c) => c.startsWith('opponent_'));
  await send(ctx, id, 'main', 'set_step_mode', [value]);
  const changed: ClientRef[] = ['main'];
  try {
    await botControl(ctx, id, 'pause');
    for (const bot of opponents) {
      await send(ctx, id, bot, 'leave_match', []);
      await send(ctx, id, bot, 'set_step_mode', [value]);
      changed.push(bot);
    }
  } catch (error) {
    const revert = on ? 'off' : 'on';
    for (const client of changed) await automationRequest(ctx, id, 'set_step_mode', [revert], client, { access: 'play' }).catch(() => undefined);
    await botControl(ctx, id, 'resume', { stepMode: !on }).catch(() => undefined);
    throw error;
  }
  await botControl(ctx, id, 'resume', { stepMode: on });
}

export const stepMode: CommandDef = {
  name: ['step-mode'],
  usage: 'ogw step-mode <instance> <on|off>',
  async run(ctx, args) {
    expectPositionals(args, 2, 2, this.usage);
    const id = positional(args, 0, 'instance');
    const value = positional(args, 1, 'on or off');
    if (value !== 'on' && value !== 'off') throw new OgwError(`usage: ${this.usage}`);
    await setStepMode(ctx, id, value === 'on');
    return { text: `step mode ${value}`, data: { stepMode: value === 'on' } };
  },
};
