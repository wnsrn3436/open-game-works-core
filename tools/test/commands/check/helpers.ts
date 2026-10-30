import { automationRequest, type AutomationResponse, type ClientRef, type RestartOptions } from '../../../src/commands/instance/automation.ts';
import type { Context } from '../../../src/lib/command.ts';

export function ok(result: unknown = null, bytes: Buffer = Buffer.alloc(0)): AutomationResponse {
  return { ok: true, result, bytes, frames: [] };
}

export function notOk(result: unknown = 'failed'): AutomationResponse {
  return { ok: false, result, bytes: Buffer.alloc(0), frames: [] };
}

export type Handler = (command: string, args: string[], client: ClientRef | undefined) => AutomationResponse | Promise<AutomationResponse>;

/** An `automationRequest` implementation from a synchronous fake; a throw becomes a rejection. */
export function fakeAutomation(reply: (command: string, args: string[]) => AutomationResponse) {
  return (_ctx: Context, _instanceId: string, command: string, args: string[]): Promise<AutomationResponse> =>
    new Promise((resolve) => {
      resolve(reply(command, args));
    });
}

/** A context for library calls that do not touch settings or the workspace. */
export function fakeContext(logs: string[] = []): Context {
  return {
    cwd: '/tmp',
    env: {},
    stdin: () => Promise.resolve(''),
    stdinLines: async function* () {},
    out: () => undefined,
    log: (line) => logs.push(line),
    settings: () => Promise.reject(new Error('no settings in this test')),
    workspace: () => Promise.reject(new Error('no workspace in this test')),
    game: () => Promise.reject(new Error('no game in this test')),
    secrets: {} as Context['secrets'],
    terminal: () => false,
    jobId: null,
  };
}

/** A QAState of a booted client with no blocker. */
export function doneState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { boot_stage: 'Done', invariant_failures: [], softlock: null, scene_key: 'lobby', content: {}, ...extra };
}

/**
 * A `restartClient` stand-in for test files that mock `automation.ts`: it sends the command through the mocked
 * `automationRequest`, then polls `get_state` (retrying failed requests) until `boot_stage` is `Done`, as the runner does.
 */
export async function fakeRestartClient(ctx: Context, id: string, client: ClientRef = 'main', options: RestartOptions = {}): Promise<Record<string, unknown>> {
  const command = options.command ?? 'restart';
  const response = await automationRequest(ctx, id, command, options.args ?? [], client);
  if (!response.ok) throw new Error(`${command} failed: ${JSON.stringify(response.result)}`);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() >= deadline) throw new Error(`boot_stage did not reach Done within ${String(timeoutMs)} ms`);
    const state = await automationRequest(ctx, id, 'get_state', [], client).catch(() => null);
    const result = state?.ok === true ? (state.result as Record<string, unknown> | null) : null;
    if (result?.boot_stage === 'Done') return result;
    if (result?.boot_stage === 'Halted') throw new Error('boot_stage is Halted');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
