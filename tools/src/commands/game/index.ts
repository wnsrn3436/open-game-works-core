import type { CommandDef } from '../../lib/command.ts';
import { check } from './check.ts';
import { derive } from './derive.ts';
import { init } from './init.ts';
import { reference } from './reference.ts';

export const commands: CommandDef[] = [init, derive, check, reference];
