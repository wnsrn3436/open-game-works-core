import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { automationRequest, type ClientRef } from '../../instance/automation.ts';

/** Poll interval and time limit of waiting for a client's `boot_stage`. Tests shorten them. */
export const WAIT = { pollMs: 250, timeoutMs: LIMITS.httpMs };

interface ClientState {
  bootStage: string;
  userId: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function userIdText(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  throw new OgwError(`get_state returned an invalid user_id: ${JSON.stringify(value)}`);
}

/** `get_state` of one client: its `boot_stage` and `user_id` (decimal, "0" before login). */
export async function clientState(ctx: Context, instance: string, client: ClientRef): Promise<ClientState> {
  const response = await automationRequest(ctx, instance, 'get_state', [], client);
  const result = response.result as Record<string, unknown> | null;
  if (!response.ok || typeof result !== 'object' || result === null) {
    throw new OgwError(`get_state of client ${client} failed: ${JSON.stringify(response.result)}`);
  }
  const bootStage = result.boot_stage;
  if (typeof bootStage !== 'string') throw new OgwError(`get_state of client ${client} has no boot_stage`);
  return { bootStage, userId: userIdText(result.user_id) };
}

function halted(instance: string, client: ClientRef): OgwError {
  return new OgwError(`client ${client} of instance ${instance}: boot_stage is Halted`);
}

/**
 * Polls `get_state` until `boot_stage` is `Done`. A failed `get_state` counts as not done. Fails at once when
 * `boot_stage` is `Halted`, and after `WAIT.timeoutMs`.
 */
async function waitDone(ctx: Context, instance: string, client: ClientRef): Promise<ClientState> {
  const deadline = Date.now() + WAIT.timeoutMs;
  let last = '';
  for (;;) {
    let state: ClientState | null = null;
    try {
      state = await clientState(ctx, instance, client);
      last = `boot_stage ${state.bootStage}`;
    } catch (error) {
      last = (error as Error).message;
    }
    if (state?.bootStage === 'Done') return state;
    if (state?.bootStage === 'Halted') throw halted(instance, client);
    if (Date.now() >= deadline) {
      throw new OgwError(
        `client ${client} of instance ${instance}: boot_stage did not reach Done within ${String(WAIT.timeoutMs)} ms (last: ${last})`,
      );
    }
    await sleep(WAIT.pollMs);
  }
}

/** The client's `get_state` `user_id`. When it is 0, waits until `boot_stage` is `Done`. */
export async function clientUserId(ctx: Context, instance: string, client: ClientRef): Promise<string> {
  let state = await clientState(ctx, instance, client);
  if (state.userId === '0') state = await waitDone(ctx, instance, client);
  if (state.userId === '0') throw new OgwError(`client ${client} of instance ${instance} has no user_id after boot_stage Done`);
  return state.userId;
}
