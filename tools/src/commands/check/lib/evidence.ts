import { join } from 'node:path';
import { writeFileAtomic } from '../../../lib/fsx.ts';
import type { CheckFailure, CheckResult } from '../api.ts';

/**
 * Where the check writes capture, video, log and result files. `dir` is relative to `root`; null keeps none.
 * With `relative`, returned paths are `dir/<name>` (game repo relative), else absolute.
 */
export interface Evidence {
  root: string;
  dir: string | null;
  relative: boolean;
}

/** Writes an evidence file and returns its path, or null when no evidence is kept. */
export async function writeEvidence(evidence: Evidence, name: string, data: string | Uint8Array): Promise<string | null> {
  if (evidence.dir === null) return null;
  const full = join(evidence.root, evidence.dir, name);
  await writeFileAtomic(full, data);
  return evidence.relative ? `${evidence.dir}/${name}` : full;
}

export function failure(where: string, message: string, evidence: readonly (string | null)[] = []): CheckFailure {
  return { where, message, evidence: evidence.filter((path): path is string => path !== null) };
}

export function checkResult(name: string, platform: string | null, failures: CheckFailure[], unknown = false): CheckResult {
  const result = unknown ? 'unknown' : failures.length === 0 ? 'pass' : 'fail';
  return { name, platform, result, failures, warnings: [] };
}
