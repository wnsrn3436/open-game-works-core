import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractErrorPairs, testRecordCoverage } from '../../../../src/commands/check/lib/test-record.ts';

/** A generated server contract in the form of `server-core` `## generated code`: `GameError`, `RPCS`, `CORE_ERRORS`. */
const GAME_CONTRACT = `export const GameError = { GAME_ERROR_UNSPECIFIED: 0, GAME_ERROR_NOT_ENOUGH_GOLD: 1000, GAME_ERROR_SOLD_OUT: 1001, GAME_ERROR_NO_LIVES: 1002 } as const;
export type GameError = (typeof GameError)[keyof typeof GameError];
export const RPCS: readonly { name: string; errors: readonly GameError[] }[] = [
  { name: 'BuyItem', errors: [GameError.GAME_ERROR_NOT_ENOUGH_GOLD, GameError.GAME_ERROR_SOLD_OUT] },
  { name: 'ClaimQuest', errors: [] },
];
export const CORE_ERRORS: ReadonlyMap<string, readonly GameError[]> = new Map<string, readonly GameError[]>([
  ['core/StartPlaySession', [GameError.GAME_ERROR_NO_LIVES, 1009 as GameError]],
]);
`;

/** A game checkout whose `server/generated/contract/game_contract.ts` is `contract`. */
function gameWith(contract: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ogw-contract-'));
  mkdirSync(join(root, 'server', 'generated', 'contract'), { recursive: true });
  writeFileSync(join(root, 'server', 'generated', 'contract', 'game_contract.ts'), contract);
  return root;
}

const PAIRS = [
  { request: 'BuyItem', error: 'GAME_ERROR_NOT_ENOUGH_GOLD' },
  { request: 'BuyItem', error: 'GAME_ERROR_SOLD_OUT' },
  { request: 'core/StartPlaySession', error: 'GAME_ERROR_NO_LIVES' },
];

const lines = (...objects: unknown[]): string => objects.map((o) => `${typeof o === 'string' ? o : JSON.stringify(o)}\n`).join('');

describe('contractErrorPairs', () => {
  it('reads the pairs of (ogw.errors) of each rpc and of (ogw.core_errors) of each core rpc from the generated contract, in their order', async () => {
    expect(await contractErrorPairs(gameWith(GAME_CONTRACT), process.env)).toEqual([...PAIRS, { request: 'core/StartPlaySession', error: '1009' }]);
  });

  it('fails when the generated contract cannot be read', async () => {
    const noContract = mkdtempSync(join(tmpdir(), 'ogw-contract-'));
    mkdirSync(join(noContract, 'server'));
    await expect(contractErrorPairs(noContract, process.env)).rejects.toThrow(
      'the GameError lists of server/generated/contract/game_contract.ts could not be read: exit code 1',
    );
    await expect(contractErrorPairs(gameWith('export const GameError = {};\nexport const RPCS = [{ name: 1, errors: [5] }];\nexport const CORE_ERRORS = new Map();\n'), process.env)).rejects.toThrow(
      'are not lists of names',
    );
  });
});

describe('testRecordCoverage', () => {
  it('passes a record in which every admin operation was sent and every pair received', () => {
    const record = lines(
      { kind: 'admin_operation', operation: 'grant_gold' },
      { kind: 'admin_operation', operation: 'grant_gold' },
      { kind: 'admin', operation: 'grant_gold', status: 403 },
      ...PAIRS.map((p) => ({ kind: 'game_error', ...p })),
      { kind: 'game_error', request: 'BuyItem', error: '1999' },
    );
    expect(testRecordCoverage(record, PAIRS)).toEqual([]);
    expect(testRecordCoverage('', [])).toEqual([]);
  });

  it('names each admin operation no test sent and each pair no test received, in order', () => {
    const record = lines(
      { kind: 'admin_operation', operation: 'grant_gold' },
      { kind: 'admin_operation', operation: 'ban_user' },
      { kind: 'admin_operation', operation: 'grant_gold' },
      { kind: 'admin', operation: 'reset', status: 200 },
      // the same error of another request, and the request with another error, are not that pair
      { kind: 'game_error', request: 'ClaimQuest', error: 'GAME_ERROR_SOLD_OUT' },
      { kind: 'game_error', request: 'BuyItem', error: 'GAME_ERROR_NOT_ENOUGH_GOLD' },
    );
    expect(testRecordCoverage(record, PAIRS)).toEqual([
      'admin operation grant_gold is sent by no test',
      'admin operation ban_user is sent by no test',
      'BuyItem GAME_ERROR_SOLD_OUT is received by no test',
      'core/StartPlaySession GAME_ERROR_NO_LIVES is received by no test',
    ]);
  });

  it('gives each line that is not a JSON object of one of the three kinds its own run failure, and judges the others', () => {
    const record = lines(
      { kind: 'admin_operation', operation: 'grant_gold' },
      'not json',
      '',
      '["admin"]',
      { kind: 'admin', operation: 'grant_gold' },
      { kind: 'admin', operation: 'grant_gold', status: 200.5 },
      { kind: 'admin', operation: 'grant_gold', status: '200' },
      { kind: 'game_error', request: 'BuyItem', error: 1000 },
      { kind: 'game_error', request: 'BuyItem', error: 'GAME_ERROR_SOLD_OUT', extra: true },
      { kind: 'user', operation: 'x' },
      '{"kind": "admin", "operation": "grant_gold", "status": 200}{"kind": "admin_operation", "operation": "x"}',
      { kind: 'admin', operation: 'grant_gold', status: 200 },
    );
    expect(testRecordCoverage(record, [])).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => `test record line ${String(n)} is malformed`));
    // a last line without its line end is still a line
    expect(testRecordCoverage('{"kind": "admin_operation", "operation": "a"}', [])).toEqual(['admin operation a is sent by no test']);
  });
});
