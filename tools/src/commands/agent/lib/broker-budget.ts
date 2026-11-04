import { flag, parseTokens, str, type CommandArgs, type CommandDef, type Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { input } from '../../input/input.ts';
import { step } from '../../step/step.ts';
import { refuseNotedPastBudget } from './play-budget.ts';

/** The arguments of a forwarded command as the CLI parses them; null when they do not parse, and the command then says why. */
function parsed(def: CommandDef, argv: readonly string[]): CommandArgs | null {
  try {
    return parseTokens(argv.slice(1).filter((token) => token !== '--json'), def.options ?? {});
  } catch (error) {
    if (error instanceof OgwError) return null;
    throw error;
  }
}

/**
 * The refusal the broker gives a forwarded `ogw step` or `ogw input` past a budget already noted
 * (`refuseNotedPastBudget`) before it starts the command, so that a refused call costs no command start; null to run
 * it. The broker notes no budget: the command notes it once the call is valid. Opening `ogw step --stream` is no input
 * or step, and the lines of a stream and the steps of `ogw input --script` go through the budget one at a time in the
 * command.
 */
export async function brokerBudgetRefusal(ctx: Context, argv: readonly string[]): Promise<string | null> {
  const def = argv[0] === 'step' ? step : argv[0] === 'input' ? input : null;
  if (def === null || argv.includes('--help')) return null;
  const args = parsed(def, argv);
  const instance = args?.positionals[0];
  if (args === null || instance === undefined || flag(args, 'stream') || str(args, 'script') !== undefined) return null;
  try {
    await refuseNotedPastBudget(ctx, def === input ? args.positionals.slice(1) : undefined, instance);
    return null;
  } catch (error) {
    if (error instanceof OgwError) return error.message;
    throw error;
  }
}
