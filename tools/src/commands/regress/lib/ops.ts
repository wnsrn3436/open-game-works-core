/** The steps of `ogw regress refresh` and admission that run other ogw commands on a regression state. */
import type { Context } from '../../../lib/command.ts';
import { parseTokens } from '../../../lib/command.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { runData } from '../../data/api.ts';
import { upgradeCommand } from '../../core/upgrade.ts';

/** `ogw core upgrade <state> --version <v>`: its output, or why it failed. */
export async function upgradeCore(ctx: Context, game: string, version: string): Promise<{ ok: boolean; text: string }> {
  try {
    const result = await upgradeCommand.run(ctx, parseTokens([game, '--version', version], upgradeCommand.options ?? {}));
    return { ok: (result.exitCode ?? 0) === 0, text: result.text ?? '' };
  } catch (error) {
    return { ok: false, text: (error as Error).message };
  }
}

/** `ogw data <state>` on a checkout; why it failed, or null. */
export async function dataTool(ctx: Context, game: GameRepo): Promise<string | null> {
  try {
    const result = await runData(ctx, game);
    if (result.exitCode === 0) return null;
    const errors = result.lines.filter((line) => line.level === 'ERROR').map((line) => `${line.where} ${line.code}`);
    return `ogw data failed (${String(result.exitCode)})${errors.length > 0 ? `: ${errors.slice(0, 3).join(', ')}` : ''}`;
  } catch (error) {
    return (error as Error).message.split('\n')[0] ?? 'ogw data failed';
  }
}
