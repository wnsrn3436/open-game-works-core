import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { orderedMembers } from '../../../src/commands/clone/guild.ts';
import { WAIT } from '../../../src/commands/clone/lib/client.ts';
import { ogw, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { FakeAdmin, makeAdminGame, SECRETS } from '../admin/lib/fake-admin.ts';
import { FakeClients } from './lib/fixture.ts';

interface Fake {
  clients: unknown;
  instanceUrl: string;
  /** `InstanceInfo.clients` of instance `i1`. */
  instanceClients: string[];
}

const fake = vi.hoisted((): Fake => ({ clients: null, instanceUrl: '', instanceClients: [] }));

vi.mock('../../../src/commands/instance/api.ts', () => ({
  listInstances: () =>
    Promise.resolve([{ id: 'i1', game: 'g', root: '/x', serverUrl: fake.instanceUrl, adminSecret: 'runner', clients: fake.instanceClients }]),
}));

vi.mock('../../../src/commands/instance/automation.ts', () => ({
  automationRequest: (_ctx: unknown, instance: string, command: string, _args: string[], client?: string) =>
    (fake.clients as FakeClients).request(instance, command, client),
}));

let ws: TestWorkspace;
const clients = new FakeClients();
fake.clients = clients;
const servers = { DEV: new FakeAdmin(), STG: new FakeAdmin(), PROD: new FakeAdmin() };
const instance = new FakeAdmin();
const all = [...Object.values(servers), instance];

const GUILD = {
  guild_id: '50',
  name: 'Knights',
  description: 'we raid',
  join_type: 'Approval',
  join_value: '12',
  leader_id: '3',
  member_count: 5,
  max_members: 30,
  members: [
    { user_id: '9', role: 'Member', joined_at: '200', active_at: '1' },
    { user_id: '7', role: 'Officer', joined_at: '150', active_at: '1' },
    { user_id: '3', role: 'Leader', joined_at: '100', active_at: '1' },
    { user_id: '8', role: 'Member', joined_at: '200', active_at: '1' },
    { user_id: '4', role: 'Officer', joined_at: '120', active_at: '1' },
  ],
};

beforeAll(async () => {
  for (const server of all) await server.start();
  fake.instanceUrl = instance.url;
  ws = makeWorkspace();
  makeAdminGame(ws, 'g', servers);
  WAIT.pollMs = 1;
  WAIT.timeoutMs = 200;
});

afterAll(async () => {
  for (const server of all) await server.stop();
});

beforeEach(() => {
  for (const server of all) server.reset();
  clients.reset();
  fake.instanceClients = [];
  servers.PROD.handlers.get_guild = () => ({ body: GUILD });
});

describe('orderedMembers', () => {
  it('orders Leader, Officer, Member, then joined_at, then user ID', () => {
    expect(orderedMembers(GUILD.members).map((m) => `${m.userId} ${m.role}`)).toEqual([
      '3 Leader',
      '4 Officer',
      '7 Officer',
      '8 Member',
      '9 Member',
    ]);
  });

  it('compares big IDs and times as integers', () => {
    const members = [
      { user_id: '10000000000000000001', role: 'Member', joined_at: '5' },
      { user_id: '9', role: 'Member', joined_at: '5' },
      { user_id: '1', role: 'Member', joined_at: '10000000000000000000' },
      { user_id: '2', role: 'Member', joined_at: '900' },
    ];
    expect(orderedMembers(members).map((m) => m.userId)).toEqual(['9', '10000000000000000001', '2', '1']);
  });

  it.each([
    [{}, 'get_guild answered without members'],
    [[{ user_id: '1', role: 'Boss', joined_at: '1' }], 'get_guild returned a member role that is not Leader, Officer, or Member: "Boss"'],
    [[{ user_id: '1', role: 1, joined_at: '1' }], 'get_guild returned a member role that is not Leader, Officer, or Member: 1'],
    [[{ user_id: 'x', role: 'Leader', joined_at: '1' }], 'get_guild returned an invalid member user_id: "x"'],
    [[{ user_id: 1.5, role: 'Leader', joined_at: '1' }], 'get_guild returned an invalid member user_id: 1.5'],
    [[{ user_id: '1', role: 'Leader', joined_at: 1 }], 'get_guild returned an invalid member joined_at: 1'],
    [[{ user_id: '1', role: 'Leader' }], 'get_guild returned an invalid member joined_at: undefined'],
    [[null], 'get_guild returned a member role that is not Leader, Officer, or Member: undefined'],
  ])('rejects %j', (members, message) => {
    expect(() => orderedMembers(members)).toThrow(message);
  });
});

describe('ogw clone guild <game> <guild ID> <env> <target user ID>...', () => {
  it('imports the PROD guild with the ordered members paired with the targets', async () => {
    servers.STG.handlers.import_guild = () => ({ body: { guild_id: '900' } });
    const before = Date.now();
    const run = await ogw(ws, ['clone', 'guild', 'g', '50', 'STG', '21', '22', '23']);
    const after = Date.now();
    expect(run).toEqual({ code: 0, stdout: 'guild_id 900\n3 -> 21 Leader\n4 -> 22 Officer\n7 -> 23 Officer\n', stderr: '' });
    expect(servers.PROD.json(0)).toEqual({ guild_id: '50' });
    expect(servers.PROD.requests[0]?.authorization).toBe(`Bearer ogw.${SECRETS.PROD}`);
    expect(servers.STG.requests[0]?.operation).toBe('import_guild');
    expect(servers.STG.requests[0]?.authorization).toBe(`Bearer ogw.${SECRETS.STG}`);
    const sent = servers.STG.json(0) as { operation_id: string };
    const m = /^clone_guild:50:([0-9]+)$/.exec(sent.operation_id);
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(before);
    expect(Number(m?.[1])).toBeLessThanOrEqual(after);
    expect(sent).toEqual({
      operation_id: sent.operation_id,
      name: 'Knights',
      description: 'we raid',
      join_type: 'Approval',
      join_value: '12',
      max_members: 30,
      members: [
        { user_id: '21', role: 'Leader' },
        { user_id: '22', role: 'Officer' },
        { user_id: '23', role: 'Officer' },
      ],
    });
  });

  it('raises max_members to the number of members when the PROD guild has more members than max_members', async () => {
    servers.PROD.handlers.get_guild = () => ({ body: { ...GUILD, max_members: 2 } });
    servers.STG.handlers.import_guild = () => ({ body: { guild_id: '900' } });
    expect((await ogw(ws, ['clone', 'guild', 'g', '50', 'STG', '21', '22', '23', '24'])).code).toBe(0);
    expect((servers.STG.json(0) as { max_members: unknown }).max_members).toBe(4);
    servers.STG.reset();
    servers.STG.handlers.import_guild = () => ({ body: { guild_id: '901' } });
    expect((await ogw(ws, ['clone', 'guild', 'g', '50', 'STG', '21'])).code).toBe(0);
    expect((servers.STG.json(0) as { max_members: unknown }).max_members).toBe(2);
  });

  it.each([['30'], [null], [1.5]])('fails when get_guild gives max_members %j', async (value) => {
    servers.PROD.handlers.get_guild = () => ({ body: { ...GUILD, max_members: value } });
    const run = await ogw(ws, ['clone', 'guild', 'g', '50', 'STG', '21']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe(`get_guild returned an invalid max_members: ${JSON.stringify(value)}\n`);
    expect(servers.STG.requests).toHaveLength(0);
  });

  it('leaves extra targets unpaired and prints JSON', async () => {
    servers.PROD.handlers.get_guild = () => ({ body: { ...GUILD, members: [GUILD.members[2]] } });
    servers.DEV.handlers.import_guild = () => ({ body: { guild_id: 901 } });
    const run = await ogw(ws, ['clone', 'guild', 'g', '50', 'DEV', '21', '22', '--json']);
    expect(JSON.parse(run.stdout)).toEqual({
      guild_id: '901',
      pairs: [{ source_user_id: '3', target_user_id: '21', role: 'Leader' }],
    });
    expect((servers.DEV.json(0) as { members: unknown }).members).toEqual([{ user_id: '21', role: 'Leader' }]);
  });

  it('fails when the import gives no guild_id', async () => {
    servers.STG.handlers.import_guild = () => ({ body: {} });
    const run = await ogw(ws, ['clone', 'guild', 'g', '50', 'STG', '21']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('import_guild returned an invalid guild_id: undefined\n');
  });

  it('stops when get_guild fails', async () => {
    servers.PROD.handlers.get_guild = () => ({ status: 404, body: { error: 'not_found' } });
    const run = await ogw(ws, ['clone', 'guild', 'g', '50', 'STG', '21']);
    expect(run.stderr).toBe('admin operation get_guild failed: HTTP 404 not_found\n');
    expect(servers.STG.requests).toHaveLength(0);
  });

  it('fails when get_guild gives int64 values that are not decimal strings', async () => {
    servers.PROD.handlers.get_guild = () => ({ body: { ...GUILD, members: [{ user_id: 3, role: 'Leader', joined_at: '100' }] } });
    const run = await ogw(ws, ['clone', 'guild', 'g', '50', 'STG', '21']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('get_guild returned an invalid member user_id: 3\n');
    expect(servers.STG.requests).toHaveLength(0);
  });

  it.each([[{ guild_id: 'x' }, '"x"'], [{ guild_id: -1 }, '-1'], [{ guild_id: 0 }, '0'], [{ guild_id: '0' }, '"0"'], [{ guild_id: '-1' }, '"-1"']])('fails when import_guild gives %j', async (body, shown) => {
    servers.STG.handlers.import_guild = () => ({ body });
    const run = await ogw(ws, ['clone', 'guild', 'g', '50', 'STG', '21']);
    expect(run.stderr).toBe(`import_guild returned an invalid guild_id: ${shown}\n`);
  });

  it.each([
    [['clone', 'guild', 'g', '50', 'STG'], 'usage'],
    [['clone', 'guild', 'g', '50', '--instance', 'i1', '5'], 'usage'],
    [['clone', 'guild', 'g', '0', 'STG', '1'], 'guild ID must be a positive decimal int64: 0'],
    [['clone', 'guild', 'g', '50', 'PROD', '1'], 'environment must be DEV or STG: PROD'],
    [['clone', 'guild', 'g', '50', 'STG', '1', 'x'], 'target user ID must be a positive decimal int64: x'],
  ])('rejects %j', async (argv, message) => {
    const run = await ogw(ws, argv);
    expect(run.code).toBe(1);
    if (message === 'usage') expect(run.stderr).toMatch(/^usage: ogw clone guild /);
    else expect(run.stderr).toBe(`${message}\n`);
    expect(servers.PROD.requests).toHaveLength(0);
  });
});

describe('ogw clone guild <game> <guild ID> --instance <id>', () => {
  it('pairs the members with the clients of the instance in the order the runner lists them', async () => {
    fake.instanceClients = ['main', 'social', 'opponent_1', 'opponent_2', 'opponent_3'];
    clients.scripts.main = [{ boot_stage: 'Done', user_id: 31 }];
    clients.scripts.social = [{ boot_stage: 'Done', user_id: 32 }];
    clients.scripts.opponent_1 = [{ boot_stage: 'Done', user_id: 33 }];
    clients.scripts.opponent_2 = [{ boot_stage: 'Done', user_id: 34 }];
    clients.scripts.opponent_3 = [{ boot_stage: 'Done', user_id: 35 }];
    instance.handlers.import_guild = () => ({ body: { guild_id: '7' } });
    const run = await ogw(ws, ['clone', 'guild', 'g', '50', '--instance', 'i1']);
    expect(run.stdout).toBe('guild_id 7\n3 -> 31 Leader\n4 -> 32 Officer\n7 -> 33 Officer\n8 -> 34 Member\n9 -> 35 Member\n');
    expect(instance.requests[0]?.authorization).toBe('Bearer ogw.runner');
    expect(clients.commands()).toEqual(['main:get_state', 'social:get_state', 'opponent_1:get_state', 'opponent_2:get_state', 'opponent_3:get_state']);
  });

  it('asks only as many clients as there are members', async () => {
    fake.instanceClients = ['main', 'social'];
    servers.PROD.handlers.get_guild = () => ({ body: { ...GUILD, members: [GUILD.members[2]] } });
    clients.scripts.main = [{ boot_stage: 'Done', user_id: 31 }];
    instance.handlers.import_guild = () => ({ body: { guild_id: '7' } });
    const run = await ogw(ws, ['clone', 'guild', 'g', '50', '--instance', 'i1']);
    expect(run.stdout).toBe('guild_id 7\n3 -> 31 Leader\n');
    expect(clients.commands()).toEqual(['main:get_state']);
  });
});
