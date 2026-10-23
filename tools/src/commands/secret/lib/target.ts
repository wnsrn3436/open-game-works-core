import { flag, type CommandArgs, type Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { gameSecretService, harnessSecretService } from '../../../lib/secrets.ts';
import { loadGameSettings } from '../../../lib/settings.ts';
import { harnessSecretNames, isScope, scopeSecretNames } from './names.ts';

/**
 * The secret store service of the secret that `<game> <DEV|STG|PROD|signing> <name>` or `--harness <name>` names;
 * fails when settings do not name it. `usage` is the usage line of the calling command.
 */
export async function secretTarget(ctx: Context, args: CommandArgs, usage: string): Promise<{ service: string; name: string }> {
  const p = args.positionals;
  if (flag(args, 'harness')) {
    const [name] = p;
    if (p.length !== 1 || name === undefined) throw new OgwError(`usage: ${usage}`);
    if (!harnessSecretNames(await ctx.settings()).includes(name)) {
      throw new OgwError(`harness settings resourceGeneration has no secret named ${name}`);
    }
    return { service: harnessSecretService(name), name };
  }
  const [game, scope, name] = p;
  if (p.length !== 3 || game === undefined || scope === undefined || name === undefined) throw new OgwError(`usage: ${usage}`);
  if (!isScope(scope)) throw new OgwError(`not DEV, STG, PROD or signing: ${scope}`);
  const repo = await ctx.game(game);
  const where = scope === 'signing' ? 'signing' : `environments.${scope}`;
  if (!scopeSecretNames(await loadGameSettings(repo.root), scope).includes(name)) {
    throw new OgwError(`game settings ${where} has no secret named ${name}`);
  }
  return { service: gameSecretService(game, scope, name), name };
}
