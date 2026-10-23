import type { CommandDef } from '../../lib/command.ts';
import { measureCommand } from './measure.ts';
import { start } from './start.ts';
import { stop } from './stop.ts';

export const commands: CommandDef[] = [start, stop, measureCommand];
