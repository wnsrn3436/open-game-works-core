import type { CommandDef } from '../../lib/command.ts';
import { finalize } from './finalize.ts';
import { firstFinalCommand } from './first-final.ts';
import { placeholder } from './placeholder.ts';
import { request } from './request.ts';
import { rigCheckCommand } from './rig-check.ts';
import { rigMeshCommand } from './rig-mesh.ts';
import { rigSplitCommand } from './rig-split.ts';
import { sync } from './sync.ts';

export const commands: CommandDef[] = [placeholder, sync, request, finalize, rigSplitCommand, rigCheckCommand, rigMeshCommand, firstFinalCommand];
