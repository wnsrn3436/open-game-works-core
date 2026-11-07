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
    // every revert runs even when another failed; a revert that failed leaves the instance in a mixed step mode, so its
    // failure is added to the failure of the command
    const revert = on ? 'off' : 'on';
    const failures: string[] = [];
    const undo = async (what: string, work: () => Promise<unknown>): Promise<void> => {
      await work().catch((undoError: unknown) => {
        failures.push(`${what}: ${(undoError as Error).message}`);
      });
    };
    for (const client of changed) await undo(`${client}: set_step_mode ${revert}`, () => send(ctx, id, client, 'set_step_mode', [revert]));
    await undo('resuming the bot loops', () => botControl(ctx, id, 'resume', { stepMode: !on }));
    if (failures.length === 0) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new OgwError(`${message}\nstep mode was not reverted: ${failures.join('; ')}`, error instanceof OgwError ? error.exitCode : 1);
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
