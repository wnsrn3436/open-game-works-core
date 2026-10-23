import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clientState, clientUserId, WAIT } from '../../../../src/commands/clone/lib/client.ts';
import type { Context } from '../../../../src/lib/command.ts';
import { FakeClients } from './fixture.ts';

const fake = vi.hoisted((): { clients: unknown } => ({ clients: null }));

vi.mock('../../../../src/commands/instance/automation.ts', () => ({
  automationRequest: (_ctx: unknown, instance: string, command: string, _args: string[], client?: string) =>
    (fake.clients as FakeClients).request(instance, command, client),
}));

const clients = new FakeClients();
fake.clients = clients;
const ctx = {} as Context;

beforeEach(() => {
  clients.reset();
  WAIT.pollMs = 1;
  WAIT.timeoutMs = 100;
});

describe('clientState', () => {
  it('reads boot_stage and user_id of the named client', async () => {
    clients.scripts.social = [{ boot_stage: 'Done', user_id: 12 }];
    expect(await clientState(ctx, 'i', 'social')).toEqual({ bootStage: 'Done', userId: '12' });
    expect(clients.calls).toEqual([{ instance: 'i', command: 'get_state', client: 'social' }]);
  });

  it.each([
    [{ boot_stage: 'Done', user_id: -1 }, 'get_state returned an invalid user_id: -1'],
    [{ boot_stage: 'Done', user_id: 1.5 }, 'get_state returned an invalid user_id: 1.5'],
    [{ boot_stage: 'Done', user_id: 2 ** 53 }, `get_state returned an invalid user_id: ${String(2 ** 53)}`],
    [{ boot_stage: 'Done', user_id: '01' }, 'get_state returned an invalid user_id: "01"'],
    [{ boot_stage: 'Done', user_id: '-1' }, 'get_state returned an invalid user_id: "-1"'],
    [{ boot_stage: 'Done' }, 'get_state returned an invalid user_id: undefined'],
    [{ boot_stage: 3, user_id: 1 }, 'get_state of client main has no boot_stage'],
    ['not-ok', 'get_state of client main failed: "busy"'],
  ] as const)('rejects %j', async (step, message) => {
    clients.scripts.main = [step];
    await expect(clientState(ctx, 'i', 'main')).rejects.toThrow(message);
  });

  it('rejects a result that is not an object', async () => {
    clients.scripts.main = [{}];
    clients.request = () => Promise.resolve({ ok: true, result: null, bytes: Buffer.alloc(0), frames: [] });
    await expect(clientState(ctx, 'i', 'main')).rejects.toThrow('get_state of client main failed: null');
    clients.request = FakeClients.prototype.request.bind(clients);
  });

  it('takes user_id "0" as not logged in', async () => {
    clients.scripts.main = [{ boot_stage: 'Login', user_id: '0' }, { boot_stage: 'Done', user_id: '4' }];
    expect(await clientUserId(ctx, 'i', 'main')).toBe('4');
  });

  it('stops waiting at once when boot_stage is Halted', async () => {
    clients.scripts.main = [{ boot_stage: 'Login', user_id: 0 }, 'error', { boot_stage: 'Halted', user_id: 0 }, { boot_stage: 'Done', user_id: 4 }];
    await expect(clientUserId(ctx, 'i', 'main')).rejects.toThrow('client main of instance i: boot_stage is Halted');
    expect(clients.calls).toHaveLength(3);
  });

  it('fails at once when the first get_state fails', async () => {
    clients.scripts.main = ['error'];
    await expect(clientUserId(ctx, 'i', 'main')).rejects.toThrow('connection closed');
    expect(clients.calls).toHaveLength(1);
  });
});
