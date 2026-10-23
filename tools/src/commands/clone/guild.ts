import { expectPositionals, positional, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { adminCall, type AdminTarget } from '../admin/api.ts';
import { cloneEnv, int64Arg } from './lib/args.ts';
import { clientUserId } from './lib/client.ts';
import { instanceClients } from './lib/clients.ts';
import { importGuildOperationId } from './lib/operation-id.ts';

const USAGE = 'ogw clone guild <game> <guild ID> <DEV|STG> <target user ID>... | ogw clone guild <game> <guild ID> --instance <id>';

const ROLES: readonly string[] = ['Leader', 'Officer', 'Member'];

export interface GuildMember {
  userId: string;
  role: string;
  joinedAt: bigint;
}

/** An `int64` of the `get_guild` output: a decimal string (`guild` `get_guild` output JSON). */
function int64Value(value: unknown, what: string): string {
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) return value;
  throw new OgwError(`get_guild returned an invalid ${what}: ${JSON.stringify(value)}`);
}

function importedGuildId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value;
  throw new OgwError(`import_guild returned an invalid guild_id: ${JSON.stringify(value)}`);
}

function member(entry: unknown): GuildMember {
  const fields = entry as Record<string, unknown> | null;
  const role = fields?.role;
  if (typeof role !== 'string' || !ROLES.includes(role)) {
    throw new OgwError(`get_guild returned a member role that is not Leader, Officer, or Member: ${JSON.stringify(role)}`);
  }
  return {
    userId: int64Value(fields?.user_id, 'member user_id'),
    role,
    joinedAt: BigInt(int64Value(fields?.joined_at, 'member joined_at')),
  };
}

/** `max_members` of `import_guild`: the PROD `max_members`, or the number of members when the guild has more. */
export function importMaxMembers(prodMaxMembers: unknown, members: number): number {
  if (typeof prodMaxMembers !== 'number' || !Number.isSafeInteger(prodMaxMembers)) {
    throw new OgwError(`get_guild returned an invalid max_members: ${JSON.stringify(prodMaxMembers)}`);
  }
  return Math.max(prodMaxMembers, members);
}

function compareBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** PROD members ordered `Leader`, `Officer`, `Member`; within a role by `joined_at`, then user ID. */
export function orderedMembers(members: unknown): GuildMember[] {
  if (!Array.isArray(members)) throw new OgwError('get_guild answered without members');
  return members
    .map(member)
    .sort(
      (a, b) =>
        ROLES.indexOf(a.role) - ROLES.indexOf(b.role) ||
        compareBig(a.joinedAt, b.joinedAt) ||
        compareBig(BigInt(a.userId), BigInt(b.userId)),
    );
}

async function targetUsers(ctx: Parameters<CommandDef['run']>[0], game: string, instance: string, needed: number): Promise<string[]> {
  const clients = (await instanceClients(ctx, game, instance)).slice(0, needed);
  const users: string[] = [];
  for (const client of clients) users.push(await clientUserId(ctx, instance, client));
  return users;
}

export const guild: CommandDef = {
  name: ['clone', 'guild'],
  usage: USAGE,
  options: { instance: { type: 'string' } },
  async run(ctx, args) {
    const instance = str(args, 'instance');
    if (instance === undefined) expectPositionals(args, 4, Number.MAX_SAFE_INTEGER, USAGE);
    else expectPositionals(args, 2, 2, USAGE);
    const game = positional(args, 0, 'game');
    const guildId = int64Arg(positional(args, 1, 'guild ID'), 'guild ID', true);
    const target: AdminTarget = instance === undefined ? cloneEnv(positional(args, 2, 'environment')) : { instance };
    const givenTargets = args.positionals.slice(3).map((id) => int64Arg(id, 'target user ID', true));
    await ctx.game(game);

    const prod = (await adminCall(ctx, game, { env: 'PROD' }, 'get_guild', { guild_id: guildId })) as Record<string, unknown> | null;
    const members = orderedMembers(prod?.members);
    const targets = instance === undefined ? givenTargets : await targetUsers(ctx, game, instance, members.length);
    const pairs = members.slice(0, targets.length).map((entry, i) => ({
      source_user_id: entry.userId,
      target_user_id: targets[i] as string,
      role: entry.role,
    }));
    const created = (await adminCall(ctx, game, target, 'import_guild', {
      operation_id: importGuildOperationId(guildId, Date.now()),
      name: prod?.name,
      description: prod?.description,
      join_type: prod?.join_type,
      join_value: prod?.join_value,
      max_members: importMaxMembers(prod?.max_members, pairs.length),
      members: pairs.map((pair) => ({ user_id: pair.target_user_id, role: pair.role })),
    })) as Record<string, unknown> | null;
    const newGuildId = importedGuildId(created?.guild_id);
    const lines = [`guild_id ${newGuildId}`, ...pairs.map((pair) => `${pair.source_user_id} -> ${pair.target_user_id} ${pair.role}`)];
    return { text: lines.join('\n'), data: { guild_id: newGuildId, pairs }, summary: { guild_id: newGuildId, members: pairs.length } };
  },
};
