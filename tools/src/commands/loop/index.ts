import type { CommandDef } from '../../lib/command.ts';
import { loopBaseline } from './baseline.ts';
import { loopDispatch } from './dispatch.ts';
import { loopEndRecord } from './end-record.ts';
import { loopEnd } from './end.ts';
import { loopEvaluate } from './evaluate.ts';
import { loopFindings } from './findings.ts';
import { loopInput } from './input.ts';
import { loopMerge } from './merge.ts';
import { loopNext } from './next.ts';
import { loopPrepareMerge } from './prepare-merge.ts';
import { loopRecord } from './record.ts';
import { loopResume } from './resume.ts';
import { loopStart } from './start.ts';
import { loopStatus } from './status.ts';
import { loopSync } from './sync.ts';
import { loopVerdict } from './verdict.ts';

export const commands: CommandDef[] = [
  loopStart,
  loopNext,
  loopStatus,
  loopPrepareMerge,
  loopEnd,
  loopInput,
  loopDispatch,
  loopSync,
  loopEvaluate,
  loopFindings,
  loopRecord,
  loopBaseline,
  loopVerdict,
  loopEndRecord,
  loopMerge,
  loopResume,
];
