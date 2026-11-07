import type { CommandDef } from '../../lib/command.ts';
import { acceptCommand, initCommand, refreshCommand, runCommand, seedCommand, stateCommand, statusCommand } from './commands.ts';
import { checkCommand, probeCommand, sideCommand } from './side-commands.ts';

export const commands: CommandDef[] = [initCommand, statusCommand, stateCommand, refreshCommand, seedCommand, runCommand, acceptCommand, sideCommand, checkCommand, probeCommand];
