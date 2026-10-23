import type { CommandDef } from '../../lib/command.ts';
import { gameState } from './game-state.ts';
import { guild } from './guild.ts';
import { sweep } from './sweep.ts';
import { user } from './user.ts';

export const commands: CommandDef[] = [user, sweep, gameState, guild];
