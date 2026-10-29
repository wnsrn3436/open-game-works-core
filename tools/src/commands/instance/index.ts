import type { CommandDef } from '../../lib/command.ts';
import { measureCommand } from './measure.ts';
import { release } from './release.ts';
import { start } from './start.ts';
import { stop } from './stop.ts';
import { wait } from './wait.ts';

export const commands: CommandDef[] = [start, stop, release, wait, measureCommand];
