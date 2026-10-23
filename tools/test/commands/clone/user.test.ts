import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WAIT } from '../../../src/commands/clone/lib/client.ts';
import { ogw, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { FakeAdmin, makeAdminGame, SECRETS } from '../admin/lib/fake-admin.ts';
import { closeRuns, FakeClients, openRunWith, snapshotText } from './lib/fixture.ts';

const fake = vi.hoisted((): { clients: unknown; instanceUrl: string } => ({ clients: null, instanceUrl: '' }));

vi.mock('../../../src/commands/instance/api.ts', () => ({
  listInstances: () => Promise.resolve([{ id: 'i1', game: 'g', root: '/x', serverUrl: fake.instanceUrl, adminSecret: 'runner' }]),
}));

vi.mock('../../../src/commands/instance/automation.ts', () => ({
  automationRequest: (_ctx: unknown, instance: string, command: string, _args: string[], client?: string) =>
    (fake.clients as FakeClients).request(instance, command, client),
  restartClient: (_ctx: unknown, instance: string, client?: string) => (fake.clients as FakeClients).restart(instance, client),
}));

let ws: TestWorkspace;
let dir: string;
const clients = new FakeClients();
fake.clients = clients;
const servers = { DEV: new FakeAdmin(), STG: new FakeAdmin(), PROD: new FakeAdmin() };
const instance = new FakeAdmin();
const all = [...Object.values(servers), instance];

beforeAll(async () => {
  for (const server of all) await server.start();
  fake.instanceUrl = instance.url;
  ws = makeWorkspace();
  dir = makeAdminGame(ws, 'g', servers);
  WAIT.pollMs = 1;
  WAIT.timeoutMs = 300;
});

afterAll(async () => {
  for (const server of all) await server.stop();
});

beforeEach(async () => {
  for (const server of all) server.reset();
  clients.reset();
  await closeRuns(dir);
});

function serve(dataVersion: string, importReply: unknown, target: FakeAdmin): string {
  const text = snapshotText(dataVersion);
  servers.PROD.handlers.export_user_snapshot = () => ({ body: text });
  target.handlers.import_user_snapshot = () => ({ body: importReply });
  return text;
}

describe('ogw clone user <game> <source> <env> <target>', () => {
  it('exports from PROD and imports the same bytes into the target user of the environment', async () => {
    const text = serve('d1', { replaced_records: 3, data_version_matches: true, data_version: 'd1' }, servers.STG);
    const run = await ogw(ws, ['clone', 'user', 'g', '11', 'STG', '22']);
    expect(run).toEqual({ code: 0, stdout: 'replaced_records 3, data_version_matches true\n', stderr: '' });
    expect(servers.PROD.requests.map((r) => r.operation)).toEqual(['export_user_snapshot']);
    expect(servers.PROD.json(0)).toEqual({ user_id: '11' });
    expect(servers.PROD.requests[0]?.authorization).toBe(`Bearer ogw.${SECRETS.PROD}`);
    const imported = servers.STG.requests[0];
    expect(imported?.operation).toBe('import_user_snapshot');
    expect(imported?.query).toEqual({ target_user_id: '22' });
    expect(imported?.body.toString('utf8')).toBe(text);
    expect(imported?.authorization).toBe(`Bearer ogw.${SECRETS.STG}`);
    expect(servers.DEV.requests).toHaveLength(0);
    expect(clients.calls).toHaveLength(0);
  });

  it('prints both data versions when they do not match', async () => {
    serve('d1', { replaced_records: 0, data_version_matches: false, data_version: 'd2' }, servers.DEV);
    const run = await ogw(ws, ['clone', 'user', 'g', '11', 'DEV', '22']);
    expect(run.stdout).toBe('replaced_records 0, data_version_matches false, snapshot data_version d1, DEV data_version d2\n');
    const json = await ogw(ws, ['clone', 'user', 'g', '11', 'DEV', '22', '--json']);
    expect(JSON.parse(json.stdout)).toEqual({
      source_user_id: '11',
      target_user_id: '22',
      replaced_records: 0,
      data_version_matches: false,
      snapshot_data_version: 'd1',
      target_data_version: 'd2',
    });
  });

  it('stops when the export fails and does not import', async () => {
    servers.PROD.handlers.export_user_snapshot = () => ({ status: 404, body: { error: 'not_found' } });
    const run = await ogw(ws, ['clone', 'user', 'g', '11', 'STG', '22']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('admin operation export_user_snapshot failed: HTTP 404 not_found\n');
    expect(servers.STG.requests).toHaveLength(0);
  });

  it('stops when the snapshot has no data_version', async () => {
    servers.PROD.handlers.export_user_snapshot = () => ({ body: { records: [] } });
    const run = await ogw(ws, ['clone', 'user', 'g', '11', 'STG', '22']);
    expect(run.stderr).toBe('the exported snapshot has no data_version\n');
    expect(servers.STG.requests).toHaveLength(0);
  });

  it.each([
    [{ replaced_records: '3', data_version_matches: true, data_version: 'd' }],
    [{ replaced_records: 3, data_version_matches: 'true', data_version: 'd' }],
    [{ replaced_records: 3, data_version_matches: true, data_version: 1 }],
    [null],
  ])('fails on an unexpected import output %j', async (body) => {
    serve('d1', body, servers.STG);
    const run = await ogw(ws, ['clone', 'user', 'g', '11', 'STG', '22']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe(`import answered an unexpected body: ${JSON.stringify(body)}\n`);
  });

  it.each([
    [['clone', 'user', 'g', '11', 'STG'], 'usage: ogw clone user <game> <source user ID> <DEV|STG> <target user ID> | ogw clone user <game> <source user ID> --instance <id> [--record]'],
    [['clone', 'user', 'g', '11', '--instance', 'i1', 'x'], 'usage: ogw clone user <game> <source user ID> <DEV|STG> <target user ID> | ogw clone user <game> <source user ID> --instance <id> [--record]'],
    [['clone', 'user', 'g', '11', 'PROD', '22'], 'environment must be DEV or STG: PROD'],
    [['clone', 'user', 'g', '0', 'STG', '22'], 'source user ID must be a positive decimal int64: 0'],
    [['clone', 'user', 'g', '011', 'STG', '22'], 'source user ID must be a positive decimal int64: 011'],
    [['clone', 'user', 'g', '9223372036854775808', 'STG', '22'], 'source user ID must be a positive decimal int64: 9223372036854775808'],
    [['clone', 'user', 'g', '11', 'STG', '-2'], 'target user ID must be a positive decimal int64: -2'],
    [['clone', 'user', 'g', '11', 'STG', '22', '--record'], '--record is taken only with --instance'],
  ])('rejects %j', async (argv, message) => {
    const run = await ogw(ws, argv);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe(`${message}\n`);
    expect(servers.PROD.requests).toHaveLength(0);
  });

  it('accepts the largest int64 user ID', async () => {
    serve('d', { replaced_records: 1, data_version_matches: true, data_version: 'd' }, servers.STG);
    const run = await ogw(ws, ['clone', 'user', 'g', '9223372036854775807', 'STG', '1']);
    expect(run.code).toBe(0);
    expect(servers.PROD.json(0)).toEqual({ user_id: '9223372036854775807' });
  });
});

describe('ogw clone user <game> <source> --instance <id>', () => {
  it('waits for the client user, imports into it, and restarts the client through the runner', async () => {
    clients.scripts.main = [{ boot_stage: 'Login', user_id: 0 }, 'error', { boot_stage: 'Done', user_id: 77 }];
    const text = serve('d1', { replaced_records: 5, data_version_matches: true, data_version: 'd1' }, instance);
    const run = await ogw(ws, ['clone', 'user', 'g', '11', '--instance', 'i1']);
    expect(run).toEqual({ code: 0, stdout: 'replaced_records 5, data_version_matches true\n', stderr: '' });
    expect(instance.requests[0]?.query).toEqual({ target_user_id: '77' });
    expect(instance.requests[0]?.authorization).toBe('Bearer ogw.runner');
    expect(instance.requests[0]?.body.toString('utf8')).toBe(text);
    expect(clients.commands()).toEqual(['main:get_state', 'main:get_state', 'main:get_state', 'main:restart']);
    expect(clients.calls.every((call) => call.instance === 'i1')).toBe(true);
  });

  it('takes a logged-in user_id given as a string without waiting', async () => {
    clients.scripts.main = [{ boot_stage: 'Done', user_id: '9007199254740993' }];
    serve('d1', { replaced_records: 1, data_version_matches: true, data_version: 'd1' }, instance);
    const run = await ogw(ws, ['clone', 'user', 'g', '11', '--instance', 'i1']);
    expect(run.code).toBe(0);
    expect(instance.requests[0]?.query).toEqual({ target_user_id: '9007199254740993' });
    expect(clients.commands()).toEqual(['main:get_state', 'main:restart']);
  });

  it('adds the result line to ## reproduction with --record and does not commit', async () => {
    const path = await openRunWith(dir, 'loop', 'update-1', '# request\n\nfix it\n\n## reproduction\n\n- step one\n\n## judge moments\n');
    clients.scripts.main = [{ boot_stage: 'Done', user_id: 5 }];
    serve('d1', { replaced_records: 2, data_version_matches: false, data_version: 'd9' }, instance);
    const run = await ogw(ws, ['clone', 'user', 'g', '11', '--instance', 'i1', '--record']);
    expect(run.stdout).toBe('replaced_records 2, data_version_matches false, snapshot data_version d1, instance data_version d9\n');
    expect(readFileSync(path, 'utf8')).toBe(
      '# request\n\nfix it\n\n## reproduction\n\n- step one\n' +
        '- `ogw clone user 11`: replaced_records 2, data_version_matches false, snapshot data_version d1, instance data_version d9\n' +
        '\n## judge moments\n',
    );
  });

  it('writes a matching result line without the data versions', async () => {
    const path = await openRunWith(dir, 'loop', 'update-2', 'request\n');
    clients.scripts.main = [{ boot_stage: 'Done', user_id: 5 }];
    serve('d1', { replaced_records: 2, data_version_matches: true, data_version: 'd1' }, instance);
    expect((await ogw(ws, ['clone', 'user', 'g', '11', '--instance', 'i1', '--record'])).code).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('request\n\n## reproduction\n\n- `ogw clone user 11`: replaced_records 2, data_version_matches true\n');
  });

  it('fails before overwriting when no loop run is open', async () => {
    clients.scripts.main = [{ boot_stage: 'Done', user_id: 5 }];
    serve('d1', { replaced_records: 2, data_version_matches: true, data_version: 'd1' }, instance);
    const none = await ogw(ws, ['clone', 'user', 'g', '11', '--instance', 'i1', '--record']);
    expect(none.code).toBe(1);
    expect(none.stderr).toBe('no open loop run for game g\n');
    await openRunWith(dir, 'build', 'build-DEV-1.0.0');
    const build = await ogw(ws, ['clone', 'user', 'g', '11', '--instance', 'i1', '--record']);
    expect(build.stderr).toBe('no open loop run for game g\n');
    expect(servers.PROD.requests).toHaveLength(0);
    expect(instance.requests).toHaveLength(0);
    expect(clients.calls).toHaveLength(0);
  });

  it('fails when the request file of the loop run is missing', async () => {
    await openRunWith(dir, 'loop', 'update-3');
    const run = await ogw(ws, ['clone', 'user', 'g', '11', '--instance', 'i1', '--record']);
    expect(run.stderr).toBe(`${dir}/records/loops/update-3/request.md does not exist\n`);
    expect(servers.PROD.requests).toHaveLength(0);
  });

  it('does not restart or record when the import fails', async () => {
    const path = await openRunWith(dir, 'loop', 'update-4', 'r\n');
    clients.scripts.main = [{ boot_stage: 'Done', user_id: 5 }];
    servers.PROD.handlers.export_user_snapshot = () => ({ body: snapshotText('d') });
    instance.handlers.import_user_snapshot = () => ({ status: 409, body: { error: 'conflict' } });
    const run = await ogw(ws, ['clone', 'user', 'g', '11', '--instance', 'i1', '--record']);
    expect(run.stderr).toBe('admin operation import_user_snapshot failed: HTTP 409 conflict\n');
    expect(clients.commands()).toEqual(['main:get_state']);
    expect(readFileSync(path, 'utf8')).toBe('r\n');
  });

  it.each(['restart failed: "no"', 'boot_stage is Halted'])('fails when the runner restart fails: %s', async (message) => {
    clients.scripts.main = [{ boot_stage: 'Done', user_id: 5 }];
    clients.restartError = message;
    serve('d', { replaced_records: 1, data_version_matches: true, data_version: 'd' }, instance);
    const run = await ogw(ws, ['clone', 'user', 'g', '11', '--instance', 'i1']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe(`${message}\n`);
    expect(clients.commands()).toEqual(['main:get_state', 'main:restart']);
  });

  it('stops waiting for the client user at once when boot_stage is Halted', async () => {
    clients.scripts.main = [{ boot_stage: 'Login', user_id: 0 }, { boot_stage: 'Halted', user_id: 0 }];
    const run = await ogw(ws, ['clone', 'user', 'g', '11', '--instance', 'i1']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('client main of instance i1: boot_stage is Halted\n');
    expect(clients.commands()).toEqual(['main:get_state', 'main:get_state']);
    expect(servers.PROD.requests).toHaveLength(0);
  });

  it('fails when the client never logs in', async () => {
    clients.scripts.main = [{ boot_stage: 'Login', user_id: 0 }, 'error'];
    const run = await ogw(ws, ['clone', 'user', 'g', '11', '--instance', 'i1']);
    expect(run.stderr).toBe('client main of instance i1: boot_stage did not reach Done within 300 ms (last: connection closed)\n');
    expect(servers.PROD.requests).toHaveLength(0);
  });

  it('fails when the client has no user after Done', async () => {
    clients.scripts.main = [{ boot_stage: 'Done', user_id: 0 }];
    const run = await ogw(ws, ['clone', 'user', 'g', '11', '--instance', 'i1']);
    expect(run.stderr).toBe('client main of instance i1 has no user_id after boot_stage Done\n');
  });
});
