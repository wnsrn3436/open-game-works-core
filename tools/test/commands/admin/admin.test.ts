import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFUSED_OPERATIONS } from '../../../src/commands/admin/admin.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ogw, makeGame, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { FakeAdmin, makeAdminGame, SECRETS, writeSecrets, gameSettings } from './lib/fake-admin.ts';

const instances = vi.hoisted(() => ({ list: [] as unknown[], filters: [] as unknown[] }));

vi.mock('../../../src/commands/instance/api.ts', () => ({
  listInstances: (_ctx: unknown, filter: unknown) => {
    instances.filters.push(filter);
    return Promise.resolve(instances.list);
  },
}));

let ws: TestWorkspace;
const servers = { DEV: new FakeAdmin(), STG: new FakeAdmin(), PROD: new FakeAdmin() };
const instanceServer = new FakeAdmin();

beforeAll(async () => {
  for (const server of [...Object.values(servers), instanceServer]) await server.start();
  ws = makeWorkspace();
  makeAdminGame(ws, 'g', servers);
});

afterAll(async () => {
  for (const server of [...Object.values(servers), instanceServer]) await server.stop();
});

beforeEach(() => {
  for (const server of [...Object.values(servers), instanceServer]) server.reset();
  instances.list = [];
  instances.filters = [];
  writeSecrets(ws, 'g');
});

describe('ogw admin <game> <env> <operation>', () => {
  it('sends the operation to that environment as operator ogw and prints the response body', async () => {
    servers.PROD.handlers.get_switches = () => ({ body: '{"maintenance":false,"kill_switches":["Login"]}' });
    const run = await ogw(ws, ['admin', 'g', 'PROD', 'get_switches']);
    expect(run).toEqual({ code: 0, stdout: '{"maintenance":false,"kill_switches":["Login"]}\n', stderr: '' });
    expect(servers.PROD.requests).toHaveLength(1);
    const request = servers.PROD.requests[0];
    expect(request?.method).toBe('POST');
    expect(request?.operation).toBe('get_switches');
    expect(request?.authorization).toBe(`Bearer ogw.${SECRETS.PROD}`);
    expect(request?.contentType).toBe('application/json');
    expect(request?.body.toString()).toBe('{}');
    expect(servers.DEV.requests).toHaveLength(0);
    expect(servers.STG.requests).toHaveLength(0);
  });

  it('uses the secret and server of DEV and STG', async () => {
    for (const env of ['DEV', 'STG'] as const) {
      servers[env].handlers.get_user = () => ({ body: { user_id: '7' } });
      const run = await ogw(ws, ['admin', 'g', env, 'get_user']);
      expect(run.code).toBe(0);
      expect(servers[env].requests[0]?.authorization).toBe(`Bearer ogw.${SECRETS[env]}`);
    }
    expect(servers.PROD.requests).toHaveLength(0);
  });

  it('sends the --body file bytes as the request body, relative to the working directory', async () => {
    const dir = join(ws.root, 'bodies');
    mkdirSync(dir, { recursive: true });
    const text = '{"user_id": 12345678901234567890, "items": []}\n';
    writeFileSync(join(dir, 'body.json'), text);
    servers.STG.handlers.grant_items = () => ({ body: { result: 'OK' } });
    const run = await ogw(ws, ['admin', 'g', 'STG', 'grant_items', '--body', 'body.json'], { cwd: dir });
    expect(run).toEqual({ code: 0, stdout: '{"result":"OK"}\n', stderr: '' });
    expect(servers.STG.requests[0]?.body.toString()).toBe(text);
  });

  it('prints the response body as formatted JSON with the global --json flag', async () => {
    servers.DEV.handlers.get_switches = () => ({ body: { maintenance: true } });
    const run = await ogw(ws, ['admin', 'g', 'DEV', 'get_switches', '--json']);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('{\n  "maintenance": true\n}\n');
    expect(servers.DEV.requests[0]?.body.toString()).toBe('{}');
    const before = await ogw(ws, ['admin', '--json', '--instance', 'i1', 'g', 'x']);
    expect(before.stderr).toBe('instance i1 of game g is not running\n');
  });

  it('fails with the HTTP status and reason and never prints the secret', async () => {
    servers.PROD.handlers.get_user = () => ({ status: 404, body: { error: 'not_found' } });
    const run = await ogw(ws, ['admin', 'g', 'PROD', 'get_user']);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('admin operation get_user failed: HTTP 404 not_found\n');
    expect(run.stderr).not.toContain(SECRETS.PROD);
  });

  it('fails without a reason when the error body has none', async () => {
    servers.PROD.handlers.get_user = () => ({ status: 500, body: { message: 'x' } });
    const run = await ogw(ws, ['admin', 'g', 'PROD', 'get_user']);
    expect(run.stderr).toBe('admin operation get_user failed: HTTP 500\n');
  });

  it('fails when the response body is not JSON', async () => {
    servers.PROD.handlers.get_user = () => ({ body: 'oops' });
    const run = await ogw(ws, ['admin', 'g', 'PROD', 'get_user']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('admin operation get_user answered HTTP 200 with a body that is not JSON\n');
  });

  it('refuses every operation a core module spec calls a binary body operation', () => {
    const modules = fileURLToPath(new URL('../../../../skills/server-core/modules/', import.meta.url));
    const binary = readdirSync(modules)
      .filter((file) => file.endsWith('.md'))
      .flatMap((file) => [...readFileSync(join(modules, file), 'utf8').matchAll(/`([a-z_]+)` is a binary body operation/g)].map((m) => m[1]));
    expect(binary.sort()).toEqual(['import_game_state', 'import_user_snapshot', 'put_update_file']);
    for (const operation of binary) expect(REFUSED_OPERATIONS).toContain(operation);
  });

  it.each(['export_user_snapshot', 'export_game_state', 'import_user_snapshot', 'import_game_state', 'put_update_file', 'import_guild'])(
    'does not send %s',
    async (operation) => {
      const run = await ogw(ws, ['admin', 'g', 'PROD', operation]);
      expect(run.code).toBe(1);
      expect(run.stderr).toBe(`ogw admin does not send ${operation}\n`);
      expect(servers.PROD.requests).toHaveLength(0);
    },
  );

  it('fails when the secret is not in the secret store', async () => {
    writeFileSync(ws.env.OGW_TEST_SECRET_FILE as string, '{}');
    const run = await ogw(ws, ['admin', 'g', 'PROD', 'get_switches']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('secret ogw/g/PROD/ogwAdminPROD is not in the secret store\n');
    expect(servers.PROD.requests).toHaveLength(0);
  });

  it('fails when the secret is empty', async () => {
    writeFileSync(ws.env.OGW_TEST_SECRET_FILE as string, JSON.stringify({ 'ogw/g/PROD/ogwAdminPROD': '' }));
    const run = await ogw(ws, ['admin', 'g', 'PROD', 'get_switches']);
    expect(run.stderr).toBe('secret ogw/g/PROD/ogwAdminPROD is not in the secret store\n');
  });

  it('fails when the environment has no operator ogw or no server URL', async () => {
    const settings = gameSettings({ DEV: servers.DEV.url, STG: servers.STG.url, PROD: servers.PROD.url });
    const envs = settings.environments as Record<string, Record<string, unknown>>;
    (envs.PROD as Record<string, unknown>).adminOperators = [{ name: 'human', roles: ['read'], secret: 'h' }];
    (envs.STG as Record<string, unknown>).serverUrl = '';
    delete (envs.DEV as Record<string, unknown>).adminOperators;
    makeGame(ws, 'h', { 'settings.json': settings });
    expect((await ogw(ws, ['admin', 'h', 'PROD', 'get_switches'])).stderr).toBe(
      'game settings environments.PROD.adminOperators has no operator ogw with a secret\n',
    );
    expect((await ogw(ws, ['admin', 'h', 'DEV', 'get_switches'])).stderr).toBe(
      'game settings environments.DEV.adminOperators has no operator ogw with a secret\n',
    );
    expect((await ogw(ws, ['admin', 'h', 'STG', 'get_switches'])).stderr).toBe('game settings environments.STG.serverUrl is not set\n');
  });

  it('fails when the game settings have no environments', async () => {
    makeGame(ws, 'k', { 'settings.json': {} });
    expect((await ogw(ws, ['admin', 'k', 'PROD', 'get_switches'])).stderr).toBe(
      'game settings environments.PROD.serverUrl is not set\n',
    );
  });

  it('joins a server URL that ends with a slash', async () => {
    const settings = gameSettings({ DEV: `${servers.DEV.url}/`, STG: servers.STG.url, PROD: servers.PROD.url });
    makeGame(ws, 'slash', { 'settings.json': settings });
    writeSecrets(ws, 'slash');
    servers.DEV.handlers.get_switches = () => ({ body: {} });
    expect((await ogw(ws, ['admin', 'slash', 'DEV', 'get_switches'])).code).toBe(0);
    expect(servers.DEV.requests[0]?.operation).toBe('get_switches');
  });

  it('fails when the server cannot be reached', async () => {
    const gone = await new FakeAdmin().start();
    await gone.stop();
    makeGame(ws, 'gone', { 'settings.json': gameSettings({ DEV: gone.url, STG: gone.url, PROD: gone.url }) });
    writeSecrets(ws, 'gone');
    const run = await ogw(ws, ['admin', 'gone', 'PROD', 'get_switches']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`admin operation get_switches to ${gone.url}/admin/get_switches failed: `);
    expect(run.stderr).not.toContain(SECRETS.PROD);
  });
});

describe('ogw admin <game> --instance <id> <operation>', () => {
  it('sends to the instance server with the secret the runner made', async () => {
    instances.list = [
      { id: 'other', game: 'g', serverUrl: servers.DEV.url, adminSecret: 'wrong' },
      { id: 'i1', game: 'g', serverUrl: instanceServer.url, adminSecret: 'runner-secret' },
    ];
    instanceServer.handlers.find_user_by_social_account = () => ({ body: { user_id: '42' } });
    const run = await ogw(ws, ['admin', 'g', '--instance', 'i1', 'find_user_by_social_account']);
    expect(run).toEqual({ code: 0, stdout: '{"user_id":"42"}\n', stderr: '' });
    expect(instanceServer.requests[0]?.authorization).toBe('Bearer ogw.runner-secret');
    expect(instances.filters).toEqual([{ game: 'g' }]);
    expect(servers.DEV.requests).toHaveLength(0);
  });

  it('fails when the instance is not running', async () => {
    const run = await ogw(ws, ['admin', 'g', '--instance', 'nope', 'get_switches']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('instance nope of game g is not running\n');
  });
});

describe('ogw admin arguments', () => {
  const usage =
    'usage: ogw admin <game> <DEV|STG|PROD> <operation> [--body <file>] | ogw admin <game> --instance <id> <operation> [--body <file>]';

  it('prints the usage for --help', async () => {
    expect(await ogw(ws, ['admin', '--help'])).toEqual({ code: 0, stdout: `${usage}\n`, stderr: '' });
  });

  it.each([
    [['admin', 'g', 'PROD'], `${usage}\n`],
    [['admin', 'g', 'PROD', 'a', 'b'], `${usage}\n`],
    [['admin', 'g', '--instance', 'i', 'a', 'b'], `${usage}\n`],
    [['admin', 'g', '--instance', 'i'], `${usage}\n`],
    [['admin', 'g', 'LOCAL', 'get_user'], 'environment must be DEV, STG, or PROD: LOCAL\n'],
    [['admin', 'g', 'PROD', 'get_user', '--x'], 'unknown option --x\n'],
    [['admin', 'g', 'get_user', '--instance'], 'option --instance needs a value\n'],
    [['admin', 'g', 'get_user', '--instance', '--body', 'f'], 'option --instance needs a value\n'],
    [['admin', 'g', 'PROD', 'get_user', '--body'], 'option --body needs a value\n'],
    [['admin', 'g', '--instance', 'a', '--instance', 'b', 'op'], 'option --instance given twice\n'],
    [['admin', 'g', 'PROD', 'op', '--body', 'a', '--body', 'b'], 'option --body given twice\n'],
    [['admin', 'g', 'PROD', 'Get-User'], 'invalid admin operation name: Get-User\n'],
    [['admin', 'g', 'PROD', 'a/../b'], 'invalid admin operation name: a/../b\n'],
  ])('rejects %j', async (argv, stderr) => {
    const run = await ogw(ws, argv);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe(stderr);
    expect(servers.PROD.requests).toHaveLength(0);
  });

  it('fails when the --body file is missing, not JSON, or not an object', async () => {
    const dir = join(ws.root, 'bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'text.json'), 'nope');
    writeFileSync(join(dir, 'array.json'), '[1]');
    writeFileSync(join(dir, 'null.json'), 'null');
    const missing = await ogw(ws, ['admin', 'g', 'PROD', 'op', '--body', 'none.json'], { cwd: dir });
    expect(missing.stderr).toMatch(new RegExp(`^cannot read --body file ${join(dir, 'none.json')}: `));
    expect((await ogw(ws, ['admin', 'g', 'PROD', 'op', '--body', 'text.json'], { cwd: dir })).stderr).toBe(
      `--body file ${join(dir, 'text.json')} is not JSON\n`,
    );
    for (const file of ['array.json', 'null.json']) {
      expect((await ogw(ws, ['admin', 'g', 'PROD', 'op', '--body', file], { cwd: dir })).stderr).toBe(
        `--body file ${join(dir, file)} is not a JSON object\n`,
      );
    }
    expect(servers.PROD.requests).toHaveLength(0);
  });
});
