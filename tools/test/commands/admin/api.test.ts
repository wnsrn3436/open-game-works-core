import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminCall, adminFailureStatus, adminSend } from '../../../src/commands/admin/api.ts';
import { createContext, type Context } from '../../../src/lib/command.ts';
import { OgwError } from '../../../src/lib/errors.ts';
import { makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { FakeAdmin, makeAdminGame, SECRETS } from './lib/fake-admin.ts';

vi.mock('../../../src/commands/instance/api.ts', () => ({
  listInstances: () => Promise.resolve([{ id: 'i1', game: 'g', serverUrl: instanceUrl.value, adminSecret: 'runner' }]),
}));

const instanceUrl = vi.hoisted(() => ({ value: '' }));

let ws: TestWorkspace;
let ctx: Context;
const servers = { DEV: new FakeAdmin(), STG: new FakeAdmin(), PROD: new FakeAdmin() };
const instance = new FakeAdmin();

beforeAll(async () => {
  for (const server of [...Object.values(servers), instance]) await server.start();
  instanceUrl.value = instance.url;
  ws = makeWorkspace();
  makeAdminGame(ws, 'g', servers);
  ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
});

afterAll(async () => {
  for (const server of [...Object.values(servers), instance]) await server.stop();
});

beforeEach(() => {
  for (const server of [...Object.values(servers), instance]) server.reset();
});

describe('adminCall', () => {
  it('sends the body as JSON and returns the parsed response body', async () => {
    servers.STG.handlers.ban_user = () => ({ body: {} });
    expect(await adminCall(ctx, 'g', { env: 'STG' }, 'ban_user', { user_id: '5', until_at: 0, reason: 'r' })).toEqual({});
    expect(servers.STG.json(0)).toEqual({ user_id: '5', until_at: 0, reason: 'r' });
    expect(servers.STG.requests[0]?.authorization).toBe(`Bearer ogw.${SECRETS.STG}`);
  });

  it('throws a OgwError whose data has the operation, status and body', async () => {
    servers.PROD.handlers.get_user = () => ({ status: 409, body: { error: 'conflict', result: 'X' } });
    const error = await adminCall(ctx, 'g', { env: 'PROD' }, 'get_user', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OgwError);
    expect((error as OgwError).data).toEqual({ operation: 'get_user', status: 409, body: { error: 'conflict', result: 'X' } });
    expect(adminFailureStatus(error)).toBe(409);
  });

  it('calls a running instance', async () => {
    instance.handlers.get_switches = () => ({ body: { maintenance: false } });
    expect(await adminCall(ctx, 'g', { instance: 'i1' }, 'get_switches', {})).toEqual({ maintenance: false });
    expect(instance.requests[0]?.authorization).toBe('Bearer ogw.runner');
  });
});

describe('adminSend with a binary body', () => {
  it('sends the query and the raw bytes as application/octet-stream', async () => {
    servers.DEV.handlers.import_user_snapshot = () => ({ body: '{"replaced_records":2}' });
    const bytes = Buffer.from('{"a":"é"}', 'utf8');
    const response = await adminSend(ctx, 'g', { env: 'DEV' }, 'import_user_snapshot', {
      query: { target_user_id: '9', x: 'a b&c' },
      bytes,
    });
    expect(response).toEqual({ status: 200, text: '{"replaced_records":2}', body: { replaced_records: 2 } });
    const request = servers.DEV.requests[0];
    expect(request?.query).toEqual({ target_user_id: '9', x: 'a b&c' });
    expect(request?.contentType).toBe('application/octet-stream');
    expect(request?.body.equals(bytes)).toBe(true);
  });

  it('sends no query string when the query is empty', async () => {
    servers.DEV.handlers.import_game_state = () => ({ body: {} });
    await adminSend(ctx, 'g', { env: 'DEV' }, 'import_game_state', { query: {}, bytes: Buffer.from('{}') });
    expect(servers.DEV.requests[0]?.query).toEqual({});
  });
});

describe('adminFailureStatus', () => {
  it('is null for other errors', () => {
    expect(adminFailureStatus(new Error('x'))).toBeNull();
    expect(adminFailureStatus(new OgwError('x'))).toBeNull();
    expect(adminFailureStatus(new OgwError('x', 1, { status: 404 }))).toBeNull();
    expect(adminFailureStatus(new OgwError('x', 1, { operation: 'a', status: '404' }))).toBeNull();
    expect(adminFailureStatus(new OgwError('x', 1, { operation: 'a', status: 404 }))).toBe(404);
  });
});
