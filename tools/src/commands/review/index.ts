import type { CommandDef } from '../../lib/command.ts';
import { clear } from './clear.ts';
import { next } from './next.ts';
import { run } from './run.ts';
import { spec } from './spec.ts';
import { status } from './status.ts';
import { wait } from './wait.ts';

export const commands: CommandDef[] = [next, wait, run, status, clear, spec];
