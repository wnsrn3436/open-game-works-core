import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ogw, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { FakeAdmin, makeAdminGame, SECRETS } from '../admin/lib/fake-admin.ts';
import { closeRuns, openRunWith } from './lib/fixture.ts';

const fake = vi.hoisted(() => ({ instanceUrl: '' }));

vi.mock('../../../src/commands/instance/api.ts', () => ({
  listInstances: () => Promise.resolve([{ id: 'i1', game: 'g', root: '/x', serverUrl: fake.instanceUrl, adminSecret: 'runner' }]),
}));

let ws: TestWorkspace;
let dir: string;
const servers = { DEV: new FakeAdmin(), STG: new FakeAdmin(), PROD: new FakeAdmin() };
const instance = new FakeAdmin();
const all = [...Object.values(servers), instance];

const ROW = { table: 'game_state', key: 'GuildBossGameState/5', contract_version: 2, value: 'CAU=' };

function gameStateText(dataVersion: string, records: unknown[]): string {
  return `{"format":1,"app_id":"com.example.test","source_environment":"PROD","data_version":"${dataVersion}","records":${JSON.stringify(records)},"sha256":"s"}`;
}

beforeAll(async () => {
  for (const server of all) await server.start();
  fake.instanceUrl = instance.url;
  ws = makeWorkspace();
  dir = makeAdminGame(ws, 'g', servers);
});

afterAll(async () => {
  for (const server of all) await server.stop();
});

beforeEach(async () => {
  for (const server of all) server.reset();
  await closeRuns(dir);
});

describe('ogw clone game-state <game> <kind> <key> <env>', () => {
  it('exports the PROD row and imports the same bytes into the environment', async () => {
    const text = gameStateText('d1', [ROW]);
    servers.PROD.handlers.export_game_state = () => ({ body: text });
    servers.STG.handlers.import_game_state = () => ({ body: { replaced_records: 1, data_version_matches: true, data_version: 'd1' } });
    const run = await ogw(ws, ['clone', 'game-state', 'g', 'GuildBossGameState', '5', 'STG']);
    expect(run).toEqual({ code: 0, stdout: 'replaced_records 1, data_version_matches true\n', stderr: '' });
    expect(servers.PROD.json(0)).toEqual({ kind: 'GuildBossGameState', keys: ['5'] });
    expect(servers.PROD.requests[0]?.authorization).toBe(`Bearer ogw.${SECRETS.PROD}`);
    const imported = servers.STG.requests[0];
    expect(imported?.operation).toBe('import_game_state');
    expect(imported?.query).toEqual({});
    expect(imported?.body.toString('utf8')).toBe(text);
    expect(imported?.authorization).toBe(`Bearer ogw.${SECRETS.STG}`);
  });

  it('passes --target-key and prints both data versions when they differ', async () => {
    servers.PROD.handlers.export_game_state = () => ({ body: gameStateText('d1', [ROW]) });
    servers.DEV.handlers.import_game_state = () => ({ body: { replaced_records: 1, data_version_matches: false, data_version: 'd2' } });
    const run = await ogw(ws, ['clone', 'game-state', 'g', 'GuildBossGameState', '0', 'DEV', '--target-key', '77']);
    expect(run.stdout).toBe('replaced_records 1, data_version_matches false, snapshot data_version d1, DEV data_version d2\n');
    expect(servers.PROD.json(0)).toEqual({ kind: 'GuildBossGameState', keys: ['0'] });
    expect(servers.DEV.requests[0]?.query).toEqual({ target_key: '77' });
    const json = await ogw(ws, ['clone', 'game-state', 'g', 'GuildBossGameState', '0', 'DEV', '--target-key', '0', '--json']);
    expect(JSON.parse(json.stdout)).toEqual({
      kind: 'GuildBossGameState',
      key: '0',
      target_key: '0',
      row: true,
      replaced_records: 1,
      data_version_matches: false,
      snapshot_data_version: 'd1',
      target_data_version: 'd2',
    });
  });

  it('writes nothing and says so when PROD has no row', async () => {
    servers.PROD.handlers.export_game_state = () => ({ body: gameStateText('d1', []) });
    const run = await ogw(ws, ['clone', 'game-state', 'g', 'GuildBossGameState', '5', 'STG']);
    expect(run).toEqual({ code: 0, stdout: 'no row: GuildBossGameState 5 in PROD\n', stderr: '' });
    expect(servers.STG.requests).toHaveLength(0);
    const json = await ogw(ws, ['clone', 'game-state', 'g', 'GuildBossGameState', '5', 'STG', '--json']);
    expect(JSON.parse(json.stdout)).toEqual({ kind: 'GuildBossGameState', key: '5', row: false });
  });

  it('fails when the export has no records array or no data_version', async () => {
    servers.PROD.handlers.export_game_state = () => ({ body: { data_version: 'd' } });
    expect((await ogw(ws, ['clone', 'game-state', 'g', 'K', '5', 'STG'])).stderr).toBe(
      'the exported game state snapshot has no records\n',
    );
    servers.PROD.handlers.export_game_state = () => ({ body: { records: [ROW] } });
    expect((await ogw(ws, ['clone', 'game-state', 'g', 'K', '5', 'STG'])).stderr).toBe('the exported snapshot has no data_version\n');
    expect(servers.STG.requests).toHaveLength(0);
  });

  it.each([
    [['clone', 'game-state', 'g', 'K', '5'], 'usage'],
    [['clone', 'game-state', 'g', 'K', '5', 'STG', 'x'], 'usage'],
    [['clone', 'game-state', 'g', 'K', '5', '--instance', 'i1', 'x'], 'usage'],
    [['clone', 'game-state', 'g', 'K', '-1', 'STG'], 'PROD key must be a non-negative decimal int64: -1'],
    [['clone', 'game-state', 'g', 'K', '5', 'PROD'], 'environment must be DEV or STG: PROD'],
    [['clone', 'game-state', 'g', 'K', '5', 'STG', '--target-key', 'a'], '--target-key must be a non-negative decimal int64: a'],
    [['clone', 'game-state', 'g', 'K', '5', 'STG', '--record'], '--record is taken only with --instance'],
  ])('rejects %j', async (argv, message) => {
    const run = await ogw(ws, argv);
    expect(run.code).toBe(1);
    if (message === 'usage') expect(run.stderr).toMatch(/^usage: ogw clone game-state /);
    else expect(run.stderr).toBe(`${message}\n`);
    expect(servers.PROD.requests).toHaveLength(0);
  });
});

describe('ogw clone game-state <game> <kind> <key> --instance <id>', () => {
  it('imports into the instance server and records the result line', async () => {
    const path = await openRunWith(dir, 'loop', 'update-1', '# r\n\n## reproduction\n\n- a\n');
    servers.PROD.handlers.export_game_state = () => ({ body: gameStateText('d1', [ROW]) });
    instance.handlers.import_game_state = () => ({ body: { replaced_records: 1, data_version_matches: false, data_version: 'd3' } });
    const run = await ogw(ws, ['clone', 'game-state', 'g', 'GuildBossGameState', '5', '--instance', 'i1', '--target-key', '9', '--record']);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('replaced_records 1, data_version_matches false, snapshot data_version d1, instance data_version d3\n');
    expect(instance.requests[0]?.authorization).toBe('Bearer ogw.runner');
    expect(instance.requests[0]?.query).toEqual({ target_key: '9' });
    expect(readFileSync(path, 'utf8')).toBe(
      '# r\n\n## reproduction\n\n- a\n- `ogw clone game-state GuildBossGameState 5`: replaced_records 1, data_version_matches false, snapshot data_version d1, instance data_version d3\n',
    );
  });

  it('records a matching result without the data versions', async () => {
    const path = await openRunWith(dir, 'loop', 'update-2', '## reproduction\n');
    servers.PROD.handlers.export_game_state = () => ({ body: gameStateText('d1', [ROW]) });
    instance.handlers.import_game_state = () => ({ body: { replaced_records: 1, data_version_matches: true, data_version: 'd1' } });
    await ogw(ws, ['clone', 'game-state', 'g', 'K', '5', '--instance', 'i1', '--record']);
    expect(readFileSync(path, 'utf8')).toBe('## reproduction\n\n- `ogw clone game-state K 5`: replaced_records 1, data_version_matches true\n');
  });

  it('records no row when PROD has no row', async () => {
    const path = await openRunWith(dir, 'loop', 'update-3', '## reproduction\n');
    servers.PROD.handlers.export_game_state = () => ({ body: gameStateText('d1', []) });
    const run = await ogw(ws, ['clone', 'game-state', 'g', 'K', '5', '--instance', 'i1', '--record']);
    expect(run.stdout).toBe('no row: K 5 in PROD\n');
    expect(readFileSync(path, 'utf8')).toBe('## reproduction\n\n- `ogw clone game-state K 5`: no row\n');
    expect(instance.requests).toHaveLength(0);
  });

  it('does not record without --record', async () => {
    const path = await openRunWith(dir, 'loop', 'update-4', '## reproduction\n');
    servers.PROD.handlers.export_game_state = () => ({ body: gameStateText('d1', []) });
    await ogw(ws, ['clone', 'game-state', 'g', 'K', '5', '--instance', 'i1']);
    expect(readFileSync(path, 'utf8')).toBe('## reproduction\n');
  });

  it('fails before exporting when no loop run is open', async () => {
    const run = await ogw(ws, ['clone', 'game-state', 'g', 'K', '5', '--instance', 'i1', '--record']);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe('no open loop run for game g\n');
    expect(servers.PROD.requests).toHaveLength(0);
  });
});
