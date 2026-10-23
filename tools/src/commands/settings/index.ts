import type { CommandDef } from '../../lib/command.ts';
import { describe } from './describe.ts';
import { get } from './get.ts';
import { list } from './list.ts';
import { set } from './set.ts';
import { unset } from './unset.ts';

export const commands: CommandDef[] = [get, describe, list, set, unset];
