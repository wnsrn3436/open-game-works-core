import type { CommandDef } from '../../lib/command.ts';
import { dependents, reviewTargetsCommand } from './dependents.ts';
import { fetchCommand } from './fetch.ts';
import { licenses } from './licenses.ts';
import { pinEngineCommand } from './pin-engine.ts';
import { proposalReleasedCommand } from './proposal-released.ts';
import { releaseCommand } from './release.ts';
import { spec } from './spec.ts';
import { testCommand } from './test.ts';
import { tryCommand } from './try.ts';
import { upgradeCommand } from './upgrade.ts';

export const commands: CommandDef[] = [
  releaseCommand,
  fetchCommand,
  upgradeCommand,
  tryCommand,
  proposalReleasedCommand,
  testCommand,
  spec,
  dependents,
  reviewTargetsCommand,
  licenses,
  pinEngineCommand,
];
