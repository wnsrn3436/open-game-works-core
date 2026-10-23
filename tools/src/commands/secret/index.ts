import type { CommandDef } from '../../lib/command.ts';
import { generate } from './generate.ts';
import { set } from './set.ts';
import { show } from './show.ts';

export const commands: CommandDef[] = [set, show, generate];
