import { describe, expect, it } from 'vitest';
import * as gameStateLock from '../../../../src/commands/check/static/game-state-lock.ts';
import { lines, memContext } from './helpers.ts';

const LOCK = "storage.lock_game_row(ctx, 'game_state', [GameContract.BossGameState, key]);";
const READ = 'const boss = storage.get_game_state(ctx, GameContract.BossGameState, key) as GameContract.BossGameState;';
const WRITE = 'storage.put_game_state(ctx, boss, 0n);';
const MESSAGE =
  "game state lock: put_game_state of (GameContract.BossGameState, key) after get_game_state without lock_game_row(ctx, 'game_state', [GameContract.BossGameState, key]) before the read";

/** A handler file whose function body is `body`. */
function handler(body: string[]): string {
  return ['export function handle(ctx: Ctx, storage: Storage, key: bigint): void {', ...body.map((l) => `  ${l}`), '}', ''].join('\n');
}

async function check(files: Record<string, string>): Promise<string[]> {
  return lines(await gameStateLock.run(memContext(files)));
}

describe('game state lock', () => {
  it('finds a read-modify-write without the lock', async () => {
    expect(await check({ 'server/handlers/Hit.ts': handler([READ, 'boss.hp -= 1n;', WRITE]) })).toEqual([`server/handlers/Hit.ts:4 | ${MESSAGE}`]);
  });

  it('passes the lock before the read', async () => {
    expect(await check({ 'server/handlers/Hit.ts': handler([LOCK, READ, 'boss.hp -= 1n;', WRITE]) })).toEqual([]);
  });

  it('finds a lock after the read', async () => {
    expect(await check({ 'server/handlers/Hit.ts': handler([READ, LOCK, 'boss.hp -= 1n;', WRITE]) })).toEqual([`server/handlers/Hit.ts:5 | ${MESSAGE}`]);
  });

  it('needs the lock of the same kind and key texts and the table game_state', async () => {
    const otherKey = "storage.lock_game_row(ctx, 'game_state', [GameContract.BossGameState, other]);";
    const otherKind = "storage.lock_game_row(ctx, 'game_state', [GameContract.RaidGameState, key]);";
    const otherTable = "storage.lock_game_row(ctx, 'guild', [GameContract.BossGameState, key]);";
    for (const lock of [otherKey, otherKind, otherTable]) {
      expect(await check({ 'server/handlers/Hit.ts': handler([lock, READ, WRITE]) })).toEqual([`server/handlers/Hit.ts:4 | ${MESSAGE}`]);
    }
    const spaced = "storage.lock_game_row(ctx, 'game_state', [ GameContract.BossGameState ,  key ]);";
    expect(await check({ 'server/handlers/Hit.ts': handler([spaced, READ, WRITE]) })).toEqual([]);
  });

  it('passes a write alone and a write of a value no read gave', async () => {
    const fresh = ['const next = new GameContract.BossGameState();', 'next.key = key;', 'storage.put_game_state(ctx, next, 0n);'];
    expect(await check({ 'server/handlers/Hit.ts': handler(fresh) })).toEqual([]);
    const otherRow = ['const raid = storage.get_game_state(ctx, GameContract.RaidGameState, key);', ...fresh];
    expect(await check({ 'server/handlers/Hit.ts': handler(otherRow) })).toEqual([]);
  });

  it('follows the read through variables, field assignments and loops', async () => {
    const body = [
      'const cur = storage.get_game_state(ctx, GameContract.BossGameState, key);',
      'const hp = (cur?.hp ?? 100n) - 1n;',
      'const next = new GameContract.BossGameState();',
      'next.hp = hp;',
      'storage.put_game_state(ctx, next, 0n);',
      'for (const row of [storage.get_game_state(ctx, GameContract.RaidGameState, 1n)]) storage.put_game_state(ctx, row!, 0n);',
    ];
    expect(await check({ 'server/handlers/Hit.ts': handler(body) })).toEqual([
      "server/handlers/Hit.ts:6 | game state lock: put_game_state of (GameContract.BossGameState, key) after get_game_state without lock_game_row(ctx, 'game_state', [GameContract.BossGameState, key]) before the read",
      "server/handlers/Hit.ts:7 | game state lock: put_game_state of (GameContract.RaidGameState, 1n) after get_game_state without lock_game_row(ctx, 'game_state', [GameContract.RaidGameState, 1n]) before the read",
    ]);
  });

  it('checks a nested function body on its own', async () => {
    const nested = [
      LOCK,
      'storage.run_user_transaction(1n, (ctx) => {',
      `  ${READ}`,
      `  ${WRITE}`,
      "  return 'pass';",
      '});',
    ];
    expect(await check({ 'server/handlers/Hit.ts': handler(nested) })).toEqual([`server/handlers/Hit.ts:5 | ${MESSAGE}`]);
    const inner = ['storage.run_user_transaction(1n, (ctx) => {', `  ${LOCK}`, `  ${READ}`, `  ${WRITE}`, "  return 'pass';", '});'];
    expect(await check({ 'server/handlers/Hit.ts': handler(inner) })).toEqual([]);
    const split = [READ, 'const write = () => storage.put_game_state(ctx, boss, 0n);', 'write();'];
    expect(await check({ 'server/handlers/Hit.ts': handler(split) })).toEqual([]);
  });

  it('checks methods and arrow functions', async () => {
    const method = ['export class Boss {', '  hit(ctx: Ctx, storage: Storage, key: bigint): void {', `    ${READ}`, `    ${WRITE}`, '  }', '}', ''].join('\n');
    const arrow = ['export const hit = (ctx: Ctx, storage: Storage, key: bigint): void => {', `  ${READ}`, `  ${WRITE}`, '};', ''].join('\n');
    expect(await check({ 'server/common/boss.ts': method, 'server/hooks/hit.ts': arrow })).toEqual([
      `server/common/boss.ts:4 | ${MESSAGE}`,
      `server/hooks/hit.ts:3 | ${MESSAGE}`,
    ]);
  });

  it('does not check DEV code, tests, generated code and core', async () => {
    const file = handler([READ, WRITE]);
    expect(
      await check({
        'server/dev/populate.ts': file,
        'server/tests/boss.test.ts': file,
        'server/generated/x.ts': file,
        'server/core/storage/x.ts': file,
      }),
    ).toEqual([]);
  });
});

describe('game state lock: variables and loops', () => {
  it('tells apart two block variables of the same name', async () => {
    const twoBlocks = handler([
      'if (key > 0n) { const boss = storage.get_game_state(ctx, GameContract.BossGameState, key); out.push(boss!.hp); }',
      'else { const boss = new GameContract.BossGameState(); storage.put_game_state(ctx, boss, 0n); }',
    ]);
    expect(await check({ 'server/handlers/Hit.ts': twoBlocks })).toEqual([]);
    const loopThenNew = handler([
      'for (const id of ids) { const row = storage.get_game_state(ctx, GameContract.BossGameState, id); out.push(row!.hp); }',
      'const row = new GameContract.BossGameState();',
      'row.key = key;',
      'storage.put_game_state(ctx, row, 0n);',
    ]);
    expect(await check({ 'server/handlers/Hit.ts': loopThenNew })).toEqual([]);
  });

  it('tells a nested function parameter apart from an outer variable of the same name', async () => {
    const shadow = handler([
      READ,
      'out.push(boss!.hp);',
      'const fresh = new GameContract.BossGameState();',
      'fresh.hp = ids.reduce((acc, boss) => acc + boss, 0n);',
      'storage.put_game_state(ctx, fresh, 0n);',
    ]);
    expect(await check({ 'server/handlers/Hit.ts': shadow })).toEqual([]);
  });

  it('follows the read into a loop variable that exists before the loop, and into a for ... in variable', async () => {
    const existing = handler([
      'let row: GameContract.BossGameState | undefined;',
      'for (row of [storage.get_game_state(ctx, GameContract.BossGameState, key)]) { out.push(1n); }',
      'storage.put_game_state(ctx, row!, 0n);',
    ]);
    expect(await check({ 'server/handlers/Hit.ts': existing })).toEqual([`server/handlers/Hit.ts:4 | ${MESSAGE}`]);
    const forIn = handler([
      READ,
      'for (const field in boss) { const next = new GameContract.BossGameState(); next[field] = field; storage.put_game_state(ctx, next, 0n); }',
    ]);
    expect(await check({ 'server/handlers/Hit.ts': forIn })).toEqual([`server/handlers/Hit.ts:3 | ${MESSAGE}`]);
  });
});
