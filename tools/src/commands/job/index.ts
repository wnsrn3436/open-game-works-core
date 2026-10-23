import type { CommandDef } from '../../lib/command.ts';
import { status } from './status.ts';
import { wait } from './wait.ts';

export const commands: CommandDef[] = [status, wait];
