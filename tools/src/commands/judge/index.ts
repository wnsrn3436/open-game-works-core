import type { CommandDef } from '../../lib/command.ts';
import { judgeCalibrate } from './calibrate.ts';
import { judgeLabel } from './label.ts';

export const commands: CommandDef[] = [judgeCalibrate, judgeLabel];
