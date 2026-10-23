import { expectPositionals, positional, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { adminSend, type AdminTarget } from '../admin/api.ts';
import { cloneEnv, int64Arg, recordFlag } from './lib/args.ts';
import { addReproductionLine, loopRequestFile } from './lib/record.ts';
import { importResult, resultLine } from './lib/result.ts';
import { snapshotDataVersion } from './user.ts';

const USAGE =
  'ogw clone game-state <game> <kind> <PROD key> <DEV|STG> [--target-key <key>] | ' +
  'ogw clone game-state <game> <kind> <PROD key> --instance <id> [--target-key <key>] [--record]';

function recordCount(body: unknown): number {
  const records = (body as Record<string, unknown> | null)?.records;
  if (!Array.isArray(records)) throw new OgwError('the exported game state snapshot has no records');
  return records.length;
}

export const gameState: CommandDef = {
  name: ['clone', 'game-state'],
  usage: USAGE,
  options: { instance: { type: 'string' }, 'target-key': { type: 'string' }, record: { type: 'boolean' } },
  async run(ctx, args) {
    const instance = str(args, 'instance');
    const record = recordFlag(args);
    const count = instance === undefined ? 4 : 3;
    expectPositionals(args, count, count, USAGE);
    const game = positional(args, 0, 'game');
    const kind = positional(args, 1, 'kind');
    const key = int64Arg(positional(args, 2, 'PROD key'), 'PROD key', false);
    const target: AdminTarget = instance === undefined ? cloneEnv(positional(args, 3, 'environment')) : { instance };
    const givenTargetKey = str(args, 'target-key');
    const targetKey = givenTargetKey === undefined ? undefined : int64Arg(givenTargetKey, '--target-key', false);
    const repo = await ctx.game(game);
    const requestFile = record ? await loopRequestFile(repo) : null;
    const prefix = `- \`ogw clone game-state ${kind} ${key}\`: `;

    const snapshot = await adminSend(ctx, game, { env: 'PROD' }, 'export_game_state', {
      jsonText: JSON.stringify({ kind, keys: [key] }),
    });
    if (recordCount(snapshot.body) === 0) {
      if (requestFile !== null) await addReproductionLine(repo, requestFile, `${prefix}no row`);
      return { text: `no row: ${kind} ${key} in PROD`, data: { kind, key, row: false }, summary: { row: false } };
    }
    const sourceDataVersion = snapshotDataVersion(snapshot.body);
    const imported = await adminSend(ctx, game, target, 'import_game_state', {
      query: targetKey === undefined ? {} : { target_key: targetKey },
      bytes: Buffer.from(snapshot.text, 'utf8'),
    });
    const result = importResult(imported.body);
    const line = resultLine(result, sourceDataVersion, 'env' in target ? target.env : 'instance');
    if (requestFile !== null) await addReproductionLine(repo, requestFile, `${prefix}${line}`);
    return {
      text: line,
      data: {
        kind,
        key,
        target_key: targetKey ?? null,
        row: true,
        replaced_records: result.replacedRecords,
        data_version_matches: result.dataVersionMatches,
        snapshot_data_version: sourceDataVersion,
        target_data_version: result.dataVersion,
      },
      summary: { row: true, replaced_records: result.replacedRecords, data_version_matches: result.dataVersionMatches },
    };
  },
};
