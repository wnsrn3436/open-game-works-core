import type { CommandDef } from '../../lib/command.ts';
import { compare } from './compare.ts';
import { telemetry } from './telemetry.ts';

export const commands: CommandDef[] = [telemetry, compare];
