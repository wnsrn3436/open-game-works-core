/**
 * Finding keys, matching, clean, catch, collateral and pipeline of the regression suite (ogw.md `### seed` and
 * `### regression state` of `## regress`).
 */
import type { CheckFailure, CheckResult } from '../../check/api.ts';
import { uiQualityFields } from '../../loop/lib/findings.ts';
import type { FixTestProof } from '../../loop/lib/files.ts';
import type { SeedManifest } from './repo.ts';

/** The file `ogw regress check` writes (ogw.md `### side`). */
export interface RegressCheckFile {
  commit: string;
  checks: CheckResult[];
  fixTestProof: FixTestProof[];
}

export type Catch = 'caught' | 'missed' | 'unknown';

/** A flash check failure (`### flash check` of `## UI quality`): its message starts with `flash`. */
function isFlash(failure: CheckFailure): boolean {
  return /^flash\b/.test(failure.message);
}

/** The finding key of a failure of check item `check` (ogw.md `### seed`). */
export function findingKey(check: Pick<CheckResult, 'name' | 'platform'>, failure: CheckFailure): string {
  const platform = check.platform ?? '-';
  const id = check.name === 'UI quality' ? uiQualityFields(failure.message).id : undefined;
  if (typeof id === 'string') return `${check.name}|${platform}|${id}`;
  const where = failure.where.replace(/:\d+(?::\d+)?$/, '');
  return `${check.name}|${platform}|${where}|${failure.message.replace(/\d+/g, '#')}`;
}

/** Every key of the failures of the `fail` items of a check file. */
export function keysOf(file: RegressCheckFile): Set<string> {
  const keys = new Set<string>();
  for (const check of file.checks) {
    if (check.result !== 'fail') continue;
    for (const failure of check.failures) keys.add(findingKey(check, failure));
  }
  return keys;
}

/** The target checks of a seed: the `check` names of its `match`. */
export function targetChecks(seed: Pick<SeedManifest, 'match'>): string[] {
  return [...new Set(seed.match.map((m) => m.check))];
}

/** Whether a failure of check `name` matches the seed (ogw.md `### seed`). */
export function matches(seed: Pick<SeedManifest, 'match'>, name: string, failure: CheckFailure): boolean {
  return seed.match.some((m) => m.check === name && new RegExp(m.where).test(failure.where) && new RegExp(m.message).test(failure.message));
}

export interface Matched {
  check: CheckResult;
  failure: CheckFailure;
}

/** The failures of `fail` items of the file that match the seed, in file order. */
export function matching(seed: Pick<SeedManifest, 'match'>, file: RegressCheckFile): Matched[] {
  const out: Matched[] = [];
  for (const check of file.checks) {
    if (check.result !== 'fail') continue;
    for (const failure of check.failures) if (matches(seed, check.name, failure)) out.push({ check, failure });
  }
  return out;
}

/**
 * The first item of the target checks that gives no result: `unknown` other than with only flash check failures, or a
 * target check the file does not hold. Null when every target item gives one.
 */
export function noResult(seed: Pick<SeedManifest, 'match'>, file: RegressCheckFile): string | null {
  for (const name of targetChecks(seed)) {
    const items = file.checks.filter((c) => c.name === name);
    if (items.length === 0) return `${name}: not in the check`;
    for (const item of items) {
      if (item.result !== 'unknown') continue;
      if (item.failures.length > 0 && item.failures.every(isFlash)) continue;
      const platform = item.platform === null ? '' : ` (${item.platform})`;
      return `${name}${platform}: unknown${item.failures[0] === undefined ? '' : `: ${item.failures[0].message}`}`;
    }
  }
  return null;
}

/** Clean for a seed (ogw.md `### regression state`): no matching failure and every target item gives a result. */
export function cleanFor(seed: Pick<SeedManifest, 'match'>, file: RegressCheckFile): { clean: boolean; reason: string | null } {
  const found = matching(seed, file)[0];
  if (found !== undefined) return { clean: false, reason: `${found.check.name} ${found.failure.where} ${found.failure.message}` };
  const none = noResult(seed, file);
  return none === null ? { clean: true, reason: null } : { clean: false, reason: none };
}

export interface CatchResult {
  catch: Catch;
  /** Why the catch is `unknown`, or what the base has of the seed for a `missed`. */
  reason: string | null;
  collateral: string[];
  pipeline: 'pass' | 'fail' | 'none' | null;
  /** The first matching failure of the seeded check of a `caught`. */
  matched: Matched | null;
}

/** The pipeline of the first matching failure: the fields `ogw loop findings` fills against `row`. */
function pipelineOf(seed: SeedManifest, matched: Matched): 'pass' | 'fail' | 'none' {
  if (matched.check.name === 'no placeholder') return 'none';
  const filled: Partial<Record<'id' | 'severity' | 'owner', string | null>> =
    matched.check.name === 'UI quality'
      ? uiQualityFields(matched.failure.message)
      : matched.check.name === 'row simulation'
        ? { owner: matched.failure.message.trim().split(/\s+/)[0] === 'error' ? 'client content' : 'data' }
        : {};
  const fields = (['id', 'severity', 'owner'] as const).filter((f) => typeof filled[f] === 'string');
  if (fields.length === 0) return 'none';
  return fields.every((f) => filled[f] === seed.row[f]) ? 'pass' : 'fail';
}

/** The catch of a seed by a side from its base check and its seeded check (ogw.md `### seed`). */
export function catchOf(seed: SeedManifest, base: RegressCheckFile, seeded: RegressCheckFile): CatchResult {
  const baseKeys = keysOf(base);
  const found = matching(seed, seeded);
  const foundKeys = new Set(found.map((m) => findingKey(m.check, m.failure)));
  const collateral = [...keysOf(seeded)].filter((key) => !baseKeys.has(key) && !foundKeys.has(key));
  if (seed.expect === 'missed') {
    const added = [...keysOf(seeded)].filter((key) => !baseKeys.has(key));
    return { catch: added.length > 0 ? 'caught' : 'missed', reason: null, collateral, pipeline: null, matched: null };
  }
  const onBase = matching(seed, base)[0];
  const first = found[0];
  if (first !== undefined && onBase === undefined) return { catch: 'caught', reason: null, collateral, pipeline: pipelineOf(seed, first), matched: first };
  const none = noResult(seed, seeded);
  if (none !== null && first === undefined) return { catch: 'unknown', reason: none, collateral, pipeline: null, matched: null };
  const reason = onBase === undefined ? null : `the base has it: ${onBase.failure.where} ${onBase.failure.message}`;
  return { catch: 'missed', reason, collateral, pipeline: null, matched: null };
}
