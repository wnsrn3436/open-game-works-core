import type { CommandDef } from '../../lib/command.ts';
import { checkCommand } from './check.ts';
import { installCommand } from './install.ts';
import { listCommand } from './list.ts';
import { measureCommand } from './measure.ts';
import { methodsCommand } from './methods.ts';
import { runCommand } from './run.ts';

export const commands: CommandDef[] = [installCommand, checkCommand, methodsCommand, runCommand, listCommand, measureCommand];
