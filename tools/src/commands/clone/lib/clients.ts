import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { listInstances } from '../../instance/api.ts';
import type { ClientRef } from '../../instance/automation.ts';

/**
 * Clients of a running instance in the order `ogw clone guild` pairs them: the runner's client list
 * (`InstanceInfo.clients`: the client that is not a bot client, the social bot client, then opponent bot clients).
 */
export async function instanceClients(ctx: Context, game: string, id: string): Promise<ClientRef[]> {
  const instance = (await listInstances(ctx, { game })).find((entry) => entry.id === id);
  if (!instance) throw new OgwError(`instance ${id} of game ${game} is not running`);
  return [...instance.clients];
}
