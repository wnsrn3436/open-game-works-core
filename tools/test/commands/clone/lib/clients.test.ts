import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { instanceClients } from '../../../../src/commands/clone/lib/clients.ts';
import { importGuildOperationId } from '../../../../src/commands/clone/lib/operation-id.ts';
import { createContext, type Context } from '../../../../src/lib/command.ts';
import { makeGame, makeWorkspace, type TestWorkspace } from '../../../helpers/workspace.ts';

const fake = vi.hoisted(() => ({ clients: [] as string[] }));

vi.mock('../../../../src/commands/instance/api.ts', () => ({
  listInstances: (_ctx: unknown, filter: { game: string }) =>
    Promise.resolve(filter.game === 'g' ? [{ id: 'i1', game: 'g', root: '/x', serverUrl: 'x', adminSecret: 'y', clients: fake.clients }] : []),
}));

let ws: TestWorkspace;
let ctx: Context;

beforeAll(() => {
  ws = makeWorkspace();
  makeGame(ws, 'g');
  ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
});

beforeEach(() => {
  fake.clients = [];
});

describe('instanceClients', () => {
  it.each([
    [['main']],
    [['main', 'social', 'opponent_1', 'opponent_2']],
    [['social', 'opponent_1']],
  ])('is the client list the runner keeps for the instance: %j', async (clients) => {
    fake.clients = clients;
    expect(await instanceClients(ctx, 'g', 'i1')).toEqual(clients);
  });

  it('fails when the instance is not running', async () => {
    await expect(instanceClients(ctx, 'g', 'i2')).rejects.toThrow('instance i2 of game g is not running');
    await expect(instanceClients(ctx, 'h', 'i1')).rejects.toThrow('instance i1 of game h is not running');
  });
});

describe('importGuildOperationId', () => {
  it('is clone_guild:<guild ID>:<unix ms>', () => {
    expect(importGuildOperationId('50', 1700000000123)).toBe('clone_guild:50:1700000000123');
  });
});
