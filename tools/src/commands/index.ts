import type { CommandDef } from '../lib/command.ts';
import { commands as loop } from './loop/index.ts';
import { commands as game } from './game/index.ts';
import { commands as settings } from './settings/index.ts';
import { commands as secret } from './secret/index.ts';
import { commands as env } from './env/index.ts';
import { commands as generation } from './generation/index.ts';
import { commands as instance } from './instance/index.ts';
import { commands as agent } from './agent/index.ts';
import { commands as job } from './job/index.ts';
import { commands as input } from './input/index.ts';
import { commands as capture } from './capture/index.ts';
import { commands as log } from './log/index.ts';
import { commands as telemetry } from './telemetry/index.ts';
import { commands as stepMode } from './step-mode/index.ts';
import { commands as step } from './step/index.ts';
import { commands as command } from './command/index.ts';
import { commands as frames } from './frames/index.ts';
import { commands as check } from './check/index.ts';
import { commands as measure } from './measure/index.ts';
import { commands as simulate } from './simulate/index.ts';
import { commands as contract } from './contract/index.ts';
import { commands as data } from './data/index.ts';
import { commands as translation } from './translation/index.ts';
import { commands as resource } from './resource/index.ts';
import { commands as build } from './build/index.ts';
import { commands as deploy } from './deploy/index.ts';
import { commands as core } from './core/index.ts';
import { commands as code } from './code/index.ts';
import { commands as review } from './review/index.ts';
import { commands as generate } from './generate/index.ts';
import { commands as meta } from './meta/index.ts';
import { commands as admin } from './admin/index.ts';
import { commands as clone } from './clone/index.ts';
import { commands as docs } from './docs/index.ts';
import { commands as video } from './video/index.ts';
import { commands as judge } from './judge/index.ts';

/** Every ogw command. Each folder owns the commands whose first word is its name. */
export const commands: readonly CommandDef[] = [
  ...loop,
  ...game,
  ...settings,
  ...secret,
  ...env,
  ...generation,
  ...instance,
  ...agent,
  ...job,
  ...input,
  ...capture,
  ...log,
  ...telemetry,
  ...stepMode,
  ...step,
  ...command,
  ...frames,
  ...check,
  ...measure,
  ...simulate,
  ...contract,
  ...data,
  ...translation,
  ...resource,
  ...build,
  ...deploy,
  ...core,
  ...code,
  ...review,
  ...generate,
  ...meta,
  ...admin,
  ...clone,
  ...docs,
  ...video,
  ...judge,
];
