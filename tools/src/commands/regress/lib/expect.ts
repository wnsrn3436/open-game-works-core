/**
 * `added` of an admission and `ogw regress expect` (ogw.md `### admission` and `### regress expect` of `## regress`): a
 * seed with `expect` `missed` that each admission check caught made a seed with `expect` `caught`, whose target checks
 * are the checks that caught it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../../lib/fsx.ts';
import { isPlainObject } from '../../../lib/json.ts';
import { escapeRegExp } from '../../../lib/regexp.ts';
import { findingKey, keysOf, type RegressCheckFile } from './keys.ts';
import type { AddedFailure, Admission, MatchItem } from './repo.ts';

/**
 * Per seeded check, the failures of its `fail` items whose finding key none of the base checks has; a check that did
 * not run has none.
 */
export function addedFailures(seeded: readonly (RegressCheckFile | null)[], bases: readonly RegressCheckFile[]): AddedFailure[][] {
  const baseKeys = new Set(bases.flatMap((file) => [...keysOf(file)]));
  return seeded.map((file) => {
    const added: AddedFailure[] = [];
    for (const check of file?.checks ?? []) {
      if (check.result !== 'fail') continue;
      for (const failure of check.failures) {
        if (!baseKeys.has(findingKey(check, failure))) added.push({ check: check.name, platform: check.platform, where: failure.where, message: failure.message });
      }
    }
    return added;
  });
}

/** The regex of a `where`: it, with any `:<line>` or `:<line>:<column>` at its end, as finding keys compare it. */
export function whereRegex(where: string): string {
  return `^${escapeRegExp(where.replace(/:\d+(?::\d+)?$/, ''))}(?::\\d+(?::\\d+)?)?$`;
}

/** The regex of a message: it, with any run of digits in place of each run of digits, as finding keys compare it. */
export function messageRegex(message: string): string {
  return `^${escapeRegExp(message).replace(/\d+/g, '\\d+')}$`;
}

/**
 * The target checks and `match` that `ogw regress expect <seed> caught` makes of an admission: the checks with an added
 * failure in each admission check, and one item per added failure of those checks; or why it cannot.
 */
export function caughtMatch(admission: Pick<Admission, 'added'>): { checks: string[]; match: MatchItem[] } | { error: string } {
  const added = admission.added;
  if (added === undefined || added === null || added.length === 0) return { error: 'its admission keeps no added failures; run ogw regress refresh' };
  const names = [...new Set(added.flat().map((failure) => failure.check))];
  const checks = names.filter((name) => added.every((list) => list.some((failure) => failure.check === name)));
  if (checks.length === 0) return { error: `no check has a failure that no base check has in each of the ${String(added.length)} admission checks` };
  const match: MatchItem[] = [];
  const seen = new Set<string>();
  for (const failure of added.flat()) {
    if (!checks.includes(failure.check)) continue;
    const item: MatchItem = { check: failure.check, where: whereRegex(failure.where), message: messageRegex(failure.message) };
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    match.push(item);
  }
  return { checks, match };
}

/** Writes `seed.json` of `folder` with `expect` `caught` and `match`, every other field as it was. */
export async function writeCaughtManifest(folder: string, match: readonly MatchItem[]): Promise<void> {
  const path = join(folder, 'seed.json');
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  const manifest = isPlainObject(value) ? value : {};
  await writeFileAtomic(path, `${JSON.stringify({ ...manifest, expect: 'caught', match }, null, 2)}\n`);
}
