import { expectPositionals, positional, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { adminSend, type AdminTarget } from '../admin/api.ts';
import { restartClient } from '../instance/automation.ts';
import { int64Arg, cloneEnv, recordFlag } from './lib/args.ts';
import { clientUserId } from './lib/client.ts';
import { addReproductionLine, loopRequestFile } from './lib/record.ts';
import { importResult, resultLine } from './lib/result.ts';

const USAGE =
  'ogw clone user <game> <source user ID> <DEV|STG> <target user ID> | ogw clone user <game> <source user ID> --instance <id> [--record]';

/** `data_version` of an exported snapshot or game state snapshot. */
export function snapshotDataVersion(body: unknown): string {
  const value = (body as Record<string, unknown> | null)?.data_version;
  if (typeof value !== 'string') throw new OgwError('the exported snapshot has no data_version');
  return value;
}

export const user: CommandDef = {
  name: ['clone', 'user'],
  usage: USAGE,
  options: { instance: { type: 'string' }, record: { type: 'boolean' } },
  async run(ctx, args) {
    const instance = str(args, 'instance');
    const record = recordFlag(args);
    expectPositionals(args, instance === undefined ? 4 : 2, instance === undefined ? 4 : 2, USAGE);
    const game = positional(args, 0, 'game');
    const source = int64Arg(positional(args, 1, 'source user ID'), 'source user ID', true);
    const target: AdminTarget = instance === undefined ? cloneEnv(positional(args, 2, 'environment')) : { instance };
    const givenTarget = instance === undefined ? int64Arg(positional(args, 3, 'target user ID'), 'target user ID', true) : null;
    const repo = await ctx.game(game);
    const requestFile = record ? await loopRequestFile(repo) : null;
    const targetUser = givenTarget ?? (await clientUserId(ctx, instance ?? '', 'main'));

    const snapshot = await adminSend(ctx, game, { env: 'PROD' }, 'export_user_snapshot', {
      jsonText: JSON.stringify({ user_id: source }),
    });
    const sourceDataVersion = snapshotDataVersion(snapshot.body);
    const imported = await adminSend(ctx, game, target, 'import_user_snapshot', {
      query: { target_user_id: targetUser },
      bytes: Buffer.from(snapshot.text, 'utf8'),
    });
    const result = importResult(imported.body);
    const label = 'env' in target ? target.env : 'instance';
    const line = resultLine(result, sourceDataVersion, label);
    if (requestFile !== null) await addReproductionLine(repo, requestFile, `- \`ogw clone user ${source}\`: ${line}`);
    if (instance !== undefined) await restartClient(ctx, instance, 'main');
    return {
      text: line,
      data: {
        source_user_id: source,
        target_user_id: targetUser,
        replaced_records: result.replacedRecords,
        data_version_matches: result.dataVersionMatches,
        snapshot_data_version: sourceDataVersion,
        target_data_version: result.dataVersion,
      },
      summary: { replaced_records: result.replacedRecords, data_version_matches: result.dataVersionMatches },
    };
  },
};
