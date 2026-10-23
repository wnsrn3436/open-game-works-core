import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { adminCall, adminFailureStatus, type AdminTarget } from '../admin/api.ts';
import { cloneEnv } from './lib/args.ts';

const USAGE = 'ogw clone sweep <game> <DEV|STG>';

interface CloneRecord {
  targetUserId: string;
  sourceUserId: string;
  sourceEnvironment: string;
  clonedAt: string;
}

function idText(value: unknown, what: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value;
  throw new OgwError(`list_clones returned an invalid ${what}: ${JSON.stringify(value)}`);
}

function cloneRecords(body: unknown): CloneRecord[] {
  const clones = (body as Record<string, unknown> | null)?.clones;
  if (!Array.isArray(clones)) throw new OgwError('list_clones answered without clones');
  return clones.map((entry: unknown) => {
    const clone = entry as Record<string, unknown> | null;
    const sourceEnvironment = clone?.source_environment;
    if (typeof sourceEnvironment !== 'string') throw new OgwError('list_clones returned a clone without source_environment');
    return {
      targetUserId: idText(clone?.target_user_id, 'target_user_id'),
      sourceUserId: idText(clone?.source_user_id, 'source_user_id'),
      sourceEnvironment,
      clonedAt: idText(clone?.cloned_at, 'cloned_at'),
    };
  });
}

/** `get_user` `withdrawn_at` (admin-api): a decimal string when the user is withdrawn, `null` when not. */
export function isWithdrawn(user: unknown): boolean {
  const withdrawnAt = (user as Record<string, unknown> | null)?.withdrawn_at;
  if (withdrawnAt === null) return false;
  if (typeof withdrawnAt === 'string' && /^[0-9]+$/.test(withdrawnAt)) return true;
  throw new OgwError(`get_user returned an invalid withdrawn_at: ${JSON.stringify(withdrawnAt)}`);
}

/** Why the clone of a PROD source user is wiped: the source user is withdrawn or not in PROD; null when it stays. */
async function wipeReason(ctx: Context, game: string, clone: CloneRecord): Promise<string | null> {
  try {
    const user = await adminCall(ctx, game, { env: 'PROD' }, 'get_user', { user_id: clone.sourceUserId });
    return isWithdrawn(user) ? 'is withdrawn' : null;
  } catch (error) {
    if (adminFailureStatus(error) !== 404) throw error;
    return 'is not in PROD';
  }
}

/**
 * Wipes the clone record read by `list_clones`: `cloned_at` makes the server keep a clone imported again since.
 * False when `wipe_clone` answers 404 `not_found` (the clone was already wiped or imported again).
 */
async function wipeClone(ctx: Context, game: string, target: AdminTarget, clone: CloneRecord): Promise<boolean> {
  try {
    await adminCall(ctx, game, target, 'wipe_clone', { target_user_id: clone.targetUserId, cloned_at: clone.clonedAt });
    return true;
  } catch (error) {
    if (adminFailureStatus(error) !== 404) throw error;
    return false;
  }
}

export const sweep: CommandDef = {
  name: ['clone', 'sweep'],
  usage: USAGE,
  async run(ctx, args) {
    expectPositionals(args, 2, 2, USAGE);
    const game = positional(args, 0, 'game');
    const target = cloneEnv(positional(args, 1, 'environment'));
    const clones = cloneRecords(await adminCall(ctx, game, target, 'list_clones', {}));
    const wiped: { target_user_id: string; source_user_id: string }[] = [];
    const gone: { target_user_id: string; source_user_id: string }[] = [];
    const lines: string[] = [];
    for (const clone of clones.filter((entry) => entry.sourceEnvironment === 'PROD')) {
      const reason = await wipeReason(ctx, game, clone);
      if (reason === null) continue;
      const entry = { target_user_id: clone.targetUserId, source_user_id: clone.sourceUserId };
      if (await wipeClone(ctx, game, target, clone)) {
        wiped.push(entry);
        lines.push(`wiped clone ${clone.targetUserId} (PROD user ${clone.sourceUserId} ${reason})`);
      } else {
        gone.push(entry);
        lines.push(`clone ${clone.targetUserId} of PROD user ${clone.sourceUserId} was already wiped or imported again`);
      }
    }
    return {
      text: lines.length === 0 ? `no clone of a withdrawn user in ${target.env}` : lines.join('\n'),
      data: { env: target.env, clones: clones.length, wiped, gone },
      summary: { wiped: wiped.length, gone: gone.length },
    };
  },
};
