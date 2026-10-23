import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ogw, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { FakeAdmin, makeAdminGame, SECRETS, type SeenRequest } from '../admin/lib/fake-admin.ts';

let ws: TestWorkspace;
const servers = { DEV: new FakeAdmin(), STG: new FakeAdmin(), PROD: new FakeAdmin() };

beforeAll(async () => {
  for (const server of Object.values(servers)) await server.start();
  ws = makeWorkspace();
  makeAdminGame(ws, 'g', servers);
});

afterAll(async () => {
  for (const server of Object.values(servers)) await server.stop();
});

beforeEach(() => {
  for (const server of Object.values(servers)) server.reset();
});

function clone(target: unknown, source: unknown, sourceEnvironment: unknown = 'PROD', clonedAt: unknown = '1'): Record<string, unknown> {
  return { target_user_id: target, source_environment: sourceEnvironment, source_user_id: source, cloned_at: clonedAt, expires_at: '2' };
}

/** PROD `get_user` answers from `users` by the requested user ID. */
function prodUsers(users: Record<string, { status?: number; body: unknown }>): void {
  servers.PROD.handlers.get_user = (request: SeenRequest) => {
    const id = (JSON.parse(request.body.toString()) as { user_id: string }).user_id;
    return users[id] ?? { status: 500, body: { error: 'internal' } };
  };
}

describe('ogw clone sweep <game> <env>', () => {
  it('wipes the clones whose PROD source user is withdrawn or not in PROD', async () => {
    servers.STG.handlers.list_clones = () => ({ body: { clones: [clone('100', '1'), clone(101, 2), clone('102', '3', 'PROD', 7), clone('103', '4')] } });
    servers.STG.handlers.wipe_clone = () => ({ body: {} });
    prodUsers({
      '1': { body: { user_id: '1', withdrawn_at: '1700000000000' } },
      '2': { body: { user_id: '2', withdrawn_at: null } },
      '3': { status: 404, body: { error: 'not_found' } },
      '4': { body: { user_id: '4', withdrawn_at: '0' } },
    });
    const run = await ogw(ws, ['clone', 'sweep', 'g', 'STG']);
    expect(run).toEqual({
      code: 0,
      stdout: 'wiped clone 100 (PROD user 1 is withdrawn)\nwiped clone 102 (PROD user 3 is not in PROD)\nwiped clone 103 (PROD user 4 is withdrawn)\n',
      stderr: '',
    });
    expect(servers.STG.requests.map((r) => r.operation)).toEqual(['list_clones', 'wipe_clone', 'wipe_clone', 'wipe_clone']);
    expect(servers.STG.json(1)).toEqual({ target_user_id: '100', cloned_at: '1' });
    expect(servers.STG.json(2)).toEqual({ target_user_id: '102', cloned_at: '7' });
    expect(servers.STG.json(3)).toEqual({ target_user_id: '103', cloned_at: '1' });
    expect(servers.STG.requests.every((r) => r.authorization === `Bearer ogw.${SECRETS.STG}`)).toBe(true);
    expect(servers.PROD.requests.map((r) => JSON.parse(r.body.toString()) as unknown)).toEqual([
      { user_id: '1' },
      { user_id: '2' },
      { user_id: '3' },
      { user_id: '4' },
    ]);
    expect(servers.PROD.requests.every((r) => r.authorization === `Bearer ogw.${SECRETS.PROD}`)).toBe(true);
    expect(servers.DEV.requests).toHaveLength(0);
    const json = await ogw(ws, ['clone', 'sweep', 'g', 'STG', '--json']);
    expect(JSON.parse(json.stdout)).toEqual({
      env: 'STG',
      clones: 4,
      wiped: [
        { target_user_id: '100', source_user_id: '1' },
        { target_user_id: '102', source_user_id: '3' },
        { target_user_id: '103', source_user_id: '4' },
      ],
      gone: [],
    });
  });

  it('reports a clone wipe_clone answers 404 not_found for and keeps sweeping the remaining clones', async () => {
    servers.STG.handlers.list_clones = () => ({ body: { clones: [clone('100', '1', 'PROD', '5'), clone('101', '2', 'PROD', '6')] } });
    servers.STG.handlers.wipe_clone = (request: SeenRequest) => {
      const body = JSON.parse(request.body.toString()) as { target_user_id: string };
      return body.target_user_id === '100' ? { status: 404, body: { error: 'not_found' } } : { body: {} };
    };
    prodUsers({ '1': { body: { withdrawn_at: '9' } }, '2': { status: 404, body: { error: 'not_found' } } });
    const run = await ogw(ws, ['clone', 'sweep', 'g', 'STG']);
    expect(run).toEqual({
      code: 0,
      stdout: 'clone 100 of PROD user 1 was already wiped or imported again\nwiped clone 101 (PROD user 2 is not in PROD)\n',
      stderr: '',
    });
    expect(servers.STG.requests.map((r) => r.operation)).toEqual(['list_clones', 'wipe_clone', 'wipe_clone']);
    expect(servers.STG.json(1)).toEqual({ target_user_id: '100', cloned_at: '5' });
    expect(servers.STG.json(2)).toEqual({ target_user_id: '101', cloned_at: '6' });
    const json = await ogw(ws, ['clone', 'sweep', 'g', 'STG', '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({
      wiped: [{ target_user_id: '101', source_user_id: '2' }],
      gone: [{ target_user_id: '100', source_user_id: '1' }],
    });
  });

  it('keeps clones whose source user is not withdrawn and skips clones not from PROD', async () => {
    servers.DEV.handlers.list_clones = () => ({ body: { clones: [clone('100', '1'), clone('101', '2', 'STG'), clone('102', '3', 'DEV')] } });
    prodUsers({ '1': { body: { user_id: '1', withdrawn_at: null } } });
    const run = await ogw(ws, ['clone', 'sweep', 'g', 'DEV']);
    expect(run).toEqual({ code: 0, stdout: 'no clone of a withdrawn user in DEV\n', stderr: '' });
    expect(servers.PROD.requests.map((r) => JSON.parse(r.body.toString()) as unknown)).toEqual([{ user_id: '1' }]);
    expect(servers.DEV.requests.map((r) => r.operation)).toEqual(['list_clones']);
  });

  it('says so when there is no clone', async () => {
    servers.STG.handlers.list_clones = () => ({ body: { clones: [] } });
    expect((await ogw(ws, ['clone', 'sweep', 'g', 'STG'])).stdout).toBe('no clone of a withdrawn user in STG\n');
    expect(servers.PROD.requests).toHaveLength(0);
  });

  it.each([[{ user_id: '1' }, 'undefined'], [{ withdrawn_at: 5 }, '5'], [{ withdrawn_at: 0 }, '0'], [{ withdrawn_at: '-1' }, '"-1"'], [null, 'undefined']])(
    'fails on a get_user withdrawn_at that is not a decimal string or null: %j',
    async (body, shown) => {
      servers.STG.handlers.list_clones = () => ({ body: { clones: [clone('100', '1')] } });
      prodUsers({ '1': { body } });
      const run = await ogw(ws, ['clone', 'sweep', 'g', 'STG']);
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(`get_user returned an invalid withdrawn_at: ${shown}\n`);
      expect(servers.STG.requests.map((r) => r.operation)).toEqual(['list_clones']);
    },
  );

  it('stops on other admin failures', async () => {
    servers.STG.handlers.list_clones = () => ({ body: { clones: [clone('100', '1')] } });
    prodUsers({ '1': { status: 401, body: { error: 'unauthorized' } } });
    const run = await ogw(ws, ['clone', 'sweep', 'g', 'STG']);
    expect(run.stderr).toBe('admin operation get_user failed: HTTP 401 unauthorized\n');
    servers.STG.reset();
    servers.STG.handlers.list_clones = () => ({ body: { clones: [clone('100', '1')] } });
    servers.STG.handlers.wipe_clone = () => ({ status: 409, body: { error: 'conflict' } });
    prodUsers({ '1': { body: { withdrawn_at: '9' } } });
    expect((await ogw(ws, ['clone', 'sweep', 'g', 'STG'])).stderr).toBe('admin operation wipe_clone failed: HTTP 409 conflict\n');
  });

  it.each([
    [{}, 'list_clones answered without clones'],
    [{ clones: [{ target_user_id: '1', source_user_id: '2' }] }, 'list_clones returned a clone without source_environment'],
    [{ clones: [clone('a', '2')] }, 'list_clones returned an invalid target_user_id: "a"'],
    [{ clones: [clone('1', 1.5)] }, 'list_clones returned an invalid source_user_id: 1.5'],
    [{ clones: [clone('1', '2', 'PROD', null)] }, 'list_clones returned an invalid cloned_at: null'],
    [{ clones: [null] }, 'list_clones returned a clone without source_environment'],
  ])('fails on list_clones output %j', async (body, message) => {
    servers.STG.handlers.list_clones = () => ({ body });
    const run = await ogw(ws, ['clone', 'sweep', 'g', 'STG']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe(`${message}\n`);
  });

  it.each([
    [['clone', 'sweep', 'g'], 'usage: ogw clone sweep <game> <DEV|STG>'],
    [['clone', 'sweep', 'g', 'STG', 'x'], 'usage: ogw clone sweep <game> <DEV|STG>'],
    [['clone', 'sweep', 'g', 'PROD'], 'environment must be DEV or STG: PROD'],
  ])('rejects %j', async (argv, message) => {
    const run = await ogw(ws, argv);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe(`${message}\n`);
  });
});
