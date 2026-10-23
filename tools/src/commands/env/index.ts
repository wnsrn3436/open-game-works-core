import type { CommandDef } from '../../lib/command.ts';
import { checkCommand } from './check.ts';
import { installEnginesCommand } from './install-engines.ts';
import { proposeCommand } from './propose.ts';

export const commands: CommandDef[] = [installEnginesCommand, checkCommand, proposeCommand];
