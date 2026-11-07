import type { CommandDef } from '../../lib/command.ts';
import { finish } from './finish.ts';
import { late } from './late.ts';
import { report } from './report.ts';
import { retry } from './retry.ts';
import { run } from './run.ts';
import { start } from './start.ts';

export const commands: CommandDef[] = [start, run, late, retry, finish, report];
