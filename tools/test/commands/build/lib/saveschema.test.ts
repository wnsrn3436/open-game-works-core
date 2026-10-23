import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminCall } from '../../../../src/commands/admin/api.ts';
import { changedKinds, contractDefs, kindColumn, reach, topLevelDefs } from '../../../../src/commands/build/lib/kinds.ts';
import { MigrationProcess, oldKinds, outputFailures, saveSchemaCheck } from '../../../../src/commands/build/lib/saveschema.ts';
import { startPostgres } from '../../../../src/commands/core/lib/postgres.ts';
import { mergedCoreSettings } from '../../../../src/commands/generate/api.ts';
import { OgwError } from '../../../../src/lib/errors.ts';
import type { Context } from '../../../../src/lib/command.ts';
import type { GameRepo } from '../../../../src/lib/game.ts';
import { commitAll, gitInit } from '../../../helpers/workspace.ts';

vi.mock('../../../../src/commands/admin/api.ts', () => ({ adminCall: vi.fn() }));
vi.mock('../../../../src/commands/core/lib/postgres.ts', () => ({ startPostgres: vi.fn() }));
vi.mock('../../../../src/commands/generate/api.ts', () => ({ mergedCoreSettings: vi.fn() }));

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const USER_V1 = `syntax = "proto3";
// quest progress
message QuestUserState {
  int64 id = 1;
  Reward reward = 2;
}
message BagUserState { int64 id = 1; }
message Helper { int32 x = 1; }
`;
const COMMON_V1 = 'message Reward {\n  int32 gold = 1;\n  Kind kind = 2;\n}\nenum Kind { KIND_NONE = 0; }\n';
const GAME_V1 = 'message BossGameState {\n  int64 key = 1;\n  int64 hp = 2;\n}\nmessage RaidGameState { int64 key = 1; }\n';

describe('changed kinds', () => {
  it('reads top-level definitions without comments and skips other blocks', () => {
    const defs = topLevelDefs('syntax = "proto3";\nservice S { rpc A (B) returns (C); }\n// c\nmessage A { message In { int32 y = 1; } int32 x = 1; }\nenum E { E_NONE = 0; }\n');
    expect([...defs.keys()]).toEqual(['A', 'E']);
    expect(defs.get('A')?.join(' ')).toBe('message A { message In { int32 y = 1 ; } int32 x = 1 ; }');
  });

  it('finds kinds by file and suffix and the definitions they reach', () => {
    const now = contractDefs(new Map([['user_state.proto', USER_V1], ['common.proto', COMMON_V1], ['game_state.proto', GAME_V1]]));
    expect(now.kinds).toEqual([
      { name: 'QuestUserState', table: 'user_state' },
      { name: 'BagUserState', table: 'user_state' },
      { name: 'BossGameState', table: 'game_state' },
      { name: 'RaidGameState', table: 'game_state' },
    ]);
    expect(reach(now.defs, 'QuestUserState')).toEqual(['QuestUserState', 'Reward', 'Kind']);
    expect(reach(now.defs, 'Missing')).toEqual([]);
  });

  it('marks a kind changed when it or a reached definition differs, not for comments or new kinds', () => {
    const prod = contractDefs(new Map([['user_state.proto', USER_V1], ['common.proto', COMMON_V1], ['game_state.proto', GAME_V1]]));
    const now = contractDefs(new Map([
      ['user_state.proto', `${USER_V1.replace('// quest progress', '// changed comment')}message NewUserState { int64 id = 1; }\n`],
      ['common.proto', COMMON_V1.replace('KIND_NONE = 0;', 'KIND_NONE = 0; KIND_A = 1;')],
      ['game_state.proto', GAME_V1.replace('int64 hp = 2;', 'int64 hp = 2 [deprecated = true];\n  int64 max_hp = 3;')],
    ]));
    expect(changedKinds(now, prod).map((k) => k.name)).toEqual(['QuestUserState', 'BossGameState']);
    expect(changedKinds(prod, prod)).toEqual([]);
  });

  it('maps a kind name to its storage kind column', () => {
    expect(kindColumn('QuestUserState')).toBe('quest_user_state');
    expect(kindColumn('PvPDeckUserState')).toBe('pv_p_deck_user_state');
    expect(kindColumn('HTTPCacheServerState')).toBe('http_cache_server_state');
  });
});

describe('samples and outputs', () => {
  it('collects the kinds of records below the current contract version', () => {
    const snapshot = {
      records: [
        { table: 'user_state', key: 'quest_user_state/1', contract_version: 1 },
        { table: 'user_state', key: 'bag_user_state/1', contract_version: 2 },
        { table: 'mailbox', key: '[1]', contract_version: 0 },
        { table: 'user_state', key: 7, contract_version: 1 },
      ],
    };
    expect([...oldKinds(snapshot, 2)]).toEqual(['user_state:quest_user_state', 'mailbox:[1]']);
    expect([...oldKinds(null, 2)]).toEqual([]);
  });

  it('reports FAILED records and a failure value', () => {
    expect(outputFailures('user 5', [
      { table: 'user_state', key: 'quest_user_state/1', from_version: 1, result: 'FAILED', error: 'boom' },
      { table: 'user_state', key: 'bag_user_state/1', from_version: 1, result: 'OK', error: '' },
    ])).toEqual(['save schema: user 5: user_state quest_user_state/1 from_version 1: boom']);
    expect(outputFailures('game state BossGameState', 'bad_request')).toEqual(['save schema: game state BossGameState: migrate_snapshot returned "bad_request"']);
  });
});

const TESTING = `
import { appendFileSync } from 'node:fs';
export async function start_test_server(...args: unknown[]) {
  console.log('log line of the test server');
  return { db: process.env.OGW_DEFAULT_DB, pg: process.env.OGW_POSTGRESQL, data: process.env.OGW_SERVER_DATA, args: args.length };
}
export async function call_dev(server: unknown, module: string, op: string, input: { bad?: boolean; crash?: boolean; records: { table: string; key: string; contract_version: number; fail?: boolean }[] }) {
  appendFileSync('calls.log', JSON.stringify({ server, module, op }) + '\\n');
  if (input.crash) process.exit(3);
  if (input.bad) return 'bad_request';
  return input.records.map((r) => ({ table: r.table, key: r.key, from_version: BigInt(r.contract_version), result: r.fail ? 'FAILED' : 'OK', error: r.fail ? 'boom' : '' }));
}
export async function stop_test_server() { appendFileSync('calls.log', 'stopped\\n'); }
`;

function game(): GameRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-save-schema-')));
  write(root, { 'server/core/testing/dev/index.ts': TESTING });
  return { name: 'g', root, mainRoot: root, commonDir: join(root, '.git'), inWorktree: false };
}

describe('migration test process', () => {
  it('sends one sample a line and reads the ogw-result line, then stops the test server', async () => {
    const g = game();
    const proc = new MigrationProcess(g.root, { ...process.env, OGW_DEFAULT_DB: 'postgresql', OGW_POSTGRESQL: 'pg', OGW_SERVER_DATA: '/d' });
    expect(await proc.migrate({ records: [{ table: 'user_state', key: 'k/1', contract_version: 1, fail: true }] }, 30_000))
      .toEqual([{ table: 'user_state', key: 'k/1', from_version: '1', result: 'FAILED', error: 'boom' }]);
    expect(await proc.migrate({ bad: true, records: [] }, 30_000)).toBe('bad_request');
    await proc.close(30_000);
    const calls = readFileSync(join(g.root, 'server', 'calls.log'), 'utf8').trim().split('\n');
    expect(JSON.parse(calls[0] ?? '')).toEqual({ server: { db: 'postgresql', pg: 'pg', data: '/d', args: 0 }, module: 'migration', op: 'migrate_snapshot' });
    expect(calls.at(-1)).toBe('stopped');
  }, 60_000);

  it('fails when the process ends without a result', async () => {
    const proc = new MigrationProcess(game().root, process.env);
    await expect(proc.migrate({ crash: true, records: [] }, 30_000)).rejects.toThrow('save schema: the migration test process ended');
    await proc.close(1000);
  }, 60_000);
});

describe('save schema check', () => {
  const ctx = {
    env: process.env,
    settings: () => Promise.resolve({ tools: { postgresql: { tag: '17.1', digest: 'sha256:x' } } }),
  } as unknown as Context;
  const remove = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    vi.mocked(adminCall).mockReset();
    remove.mockClear();
    vi.mocked(startPostgres).mockResolvedValue({ id: 'c', createDatabase: (name) => Promise.resolve(`postgresql://p/${name}`), remove });
    vi.mocked(mergedCoreSettings).mockResolvedValue({ 'migration.testSampleCount': 2 });
  });

  function repo(): { g: GameRepo; prod: string } {
    const g = game();
    gitInit(g.root);
    write(g.root, { 'contract/user_state.proto': USER_V1, 'contract/common.proto': COMMON_V1, 'contract/game_state.proto': GAME_V1 });
    const prod = commitAll(g.root, 'prod');
    write(g.root, {
      'contract/user_state.proto': USER_V1.replace('Reward reward = 2;', 'Reward reward = 2;\n  int32 step = 3;'),
      'contract/game_state.proto': GAME_V1.replace('int64 hp = 2;', 'int64 hp = 2;\n  int64 max_hp = 3;').replace('RaidGameState { int64 key = 1; }', 'RaidGameState { int64 key = 1; int32 n = 2; }'),
    });
    commitAll(g.root, 'now');
    return { g, prod };
  }

  it('samples PROD, migrates each sample and reports FAILED records and unknown kinds', async () => {
    const { g, prod } = repo();
    vi.mocked(adminCall).mockImplementation((_ctx, _game, target, operation, body) => {
      expect(target).toEqual({ env: 'PROD' });
      const b = body as Record<string, unknown>;
      if (operation === 'sample_user_ids') return Promise.resolve({ user_ids: ['11', '12'] });
      if (operation === 'export_user_snapshot') {
        const fail = b.user_id === '12';
        return Promise.resolve({ records: [{ table: 'user_state', key: 'quest_user_state/1', contract_version: 1, fail }] });
      }
      return Promise.resolve({ records: b.kind === 'BossGameState' ? [{ table: 'game_state', key: 'boss_game_state/1', contract_version: 2 }] : [] });
    });
    const outcome = await saveSchemaCheck({ ctx, game: g, prodCommit: prod, currentVersion: 2 });
    expect(outcome).toEqual({
      failures: ['save schema: user 12: user_state quest_user_state/1 from_version 1: boom'],
      unknownKinds: ['BossGameState', 'RaidGameState'],
    });
    expect(vi.mocked(adminCall).mock.calls.map((c) => [c[3], c[4]])).toEqual([
      ['sample_user_ids', { count: 2 }],
      ['export_user_snapshot', { user_id: '11' }],
      ['export_user_snapshot', { user_id: '12' }],
      ['sample_game_state', { kind: 'BossGameState', count: 2 }],
      ['sample_game_state', { kind: 'RaidGameState', count: 2 }],
    ]);
    expect(remove).toHaveBeenCalledTimes(1);
    const first = JSON.parse(readFileSync(join(g.root, 'server', 'calls.log'), 'utf8').split('\n')[0] ?? '') as { server: { pg: string; db: string } };
    expect(first.server).toMatchObject({ pg: 'postgresql://p/ogw_save_schema', db: 'postgresql' });
  }, 60_000);

  it('reports a PROD admin API failure as a save schema failure', async () => {
    const { g, prod } = repo();
    vi.mocked(adminCall).mockRejectedValue(new OgwError('admin operation sample_user_ids failed: HTTP 401'));
    const outcome = await saveSchemaCheck({ ctx, game: g, prodCommit: prod, currentVersion: 2 });
    expect(outcome.failures).toEqual(['save schema: PROD admin API: admin operation sample_user_ids failed: HTTP 401']);
    expect(remove).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('needs migration.testSampleCount and rethrows errors that are not ogw errors', async () => {
    const { g, prod } = repo();
    vi.mocked(mergedCoreSettings).mockResolvedValue({});
    await expect(saveSchemaCheck({ ctx, game: g, prodCommit: prod, currentVersion: 2 })).rejects.toThrow('merged core settings have no migration.testSampleCount');
    vi.mocked(mergedCoreSettings).mockResolvedValue({ 'migration.testSampleCount': 1 });
    vi.mocked(adminCall).mockRejectedValue(new TypeError('bug'));
    await expect(saveSchemaCheck({ ctx, game: g, prodCommit: prod, currentVersion: 2 })).rejects.toThrow('bug');
    expect(remove).toHaveBeenCalledTimes(1);
  }, 60_000);
});
