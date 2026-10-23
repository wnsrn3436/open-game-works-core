import type { CommandDef } from '../../lib/command.ts';
import { agent, agentRun } from './agent.ts';
import { merge } from './merge.ts';
import { retry } from './retry.ts';
import { status } from './status.ts';
import { stop } from './stop.ts';
import { wait } from './wait.ts';

export const commands: CommandDef[] = [agent, agentRun, status, stop, wait, merge, retry];
