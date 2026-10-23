/** Loop helpers other groups use (the build group runs loop steps inside a build run). */
export { assumptionItems, needsHumanLines, type Assumption } from './assumptions.ts';
export { runBaseline } from './baseline.ts';
export { evaluate, evaluateDeps, type EvaluatePlan } from './evaluate.ts';
export { collectHardeningFindings, hardeningRecords, iterationFindings } from './findings.ts';
export { recordFindings, type RecordResult } from './record.ts';
export { requireReference } from './setup.ts';
export { CORE_UPGRADE_KEY, loopData, openTarget, runRel, type CoreUpgradeData, type LoopData } from './run.ts';
export { sync, syncText, type SyncResult } from './sync.ts';
export type { CheckFile, EvaluateFile, JudgeEntry, MeasureFile, PlayEntry } from './files.ts';
export type { Defect, DefectsFile, Finding, FindingsFile } from './defects.ts';
