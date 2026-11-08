/**
 * The defects of the base fix of `ogw regress refresh` (ogw.md `### regress refresh` of `## regress`): the failures of
 * the base checks of a state that fail a target check of a seed of the state, as the defects of one content agent. They
 * are failures of the base, which hold no seed.
 */
import type { CheckFailure } from '../../check/api.ts';
import { DEFECT_COLUMNS, defectRow, type Defect } from '../../loop/lib/defects.ts';
import { kebab, uiQualityFields } from '../../loop/lib/findings.ts';
import { document, renderTable } from '../../loop/lib/markdown.ts';
import { findingKey, matches, type RegressCheckFile } from './keys.ts';
import type { Seed } from './repo.ts';

/** A base check and the path of its check file, which the content agent reads beside its evidence. */
export interface BaseCheckAt {
  file: RegressCheckFile;
  path: string;
}

/** The owners of the first folders of a `where` (the content code and data folders of a game repo). */
const FOLDER_OWNERS: readonly [string, string][] = [
  ['server/', 'server content'],
  ['data/', 'data'],
  ['contract/', 'contract'],
  ['resource/', 'resource'],
];

/**
 * The `owner` of a failure: that of `## loop findings` for UI quality and row simulation, else that of the first folder
 * of its `where`, and `client content` for a `where` in no such folder (a scene, a scenario step, `client/`).
 */
function ownerOf(check: string, failure: CheckFailure): string {
  if (check === 'row simulation') return failure.message.trim().split(/\s+/)[0] === 'error' ? 'client content' : 'data';
  return FOLDER_OWNERS.find(([folder]) => failure.where.startsWith(folder))?.[1] ?? 'client content';
}

/** One defect of a failure, `id` before the `-<n>` of a repeated one. */
function defectOf(check: string, failure: CheckFailure, evidence: string[]): Defect {
  const ui = check === 'UI quality' ? uiQualityFields(failure.message) : {};
  return {
    id: typeof ui.id === 'string' ? ui.id : kebab(`${check} ${failure.where.replace(/:\d+(?::\d+)?$/, '')}`),
    severity: 'major',
    owner: typeof ui.owner === 'string' ? ui.owner : ownerOf(check, failure),
    where: failure.where,
    what: failure.message,
    why: typeof ui.why === 'string' ? ui.why : `the ${check} check fails`,
    evidence,
    source: 'check',
    status: 'open',
    refusedReason: null,
    repeatedDefect: 0,
    oscillation: 0,
  };
}

/**
 * The base defects (ogw.md `### regress refresh`): one per finding key without its platform of the failures of `fail`
 * items of the base checks that match a seed of `seeds`, other than those of `no placeholder`, in the order of their
 * first failure; an `unknown` item, whose failures say why it gives no result, gives none. Its `evidence` is, per base
 * check with such a failure, the path of the check file and the check name, then the evidence of its failures.
 */
export function baseDefects(seeds: readonly Seed[], checks: readonly BaseCheckAt[]): Defect[] {
  const defects = new Map<string, Defect>();
  const ids = new Map<string, number>();
  for (const { file, path } of checks) {
    for (const check of file.checks) {
      if (check.result !== 'fail' || check.name === 'no placeholder') continue;
      for (const failure of check.failures) {
        if (!seeds.some((seed) => matches(seed.manifest, check.name, failure))) continue;
        const key = findingKey({ name: check.name, platform: null }, failure);
        const evidence = [`${path}#${check.name}`, ...failure.evidence];
        const seen = defects.get(key);
        if (seen !== undefined) {
          for (const e of evidence) if (!seen.evidence.includes(e)) seen.evidence.push(e);
          continue;
        }
        const defect = defectOf(check.name, failure, evidence);
        const n = (ids.get(defect.id) ?? 0) + 1;
        ids.set(defect.id, n);
        defects.set(key, n === 1 ? defect : { ...defect, id: `${defect.id}-${String(n)}` });
      }
    }
  }
  return [...defects.values()];
}

/** The content input of the base fix: that of a completeness iteration (`### seed-run` 1) with the base defects. */
export function baseFixInput(defects: readonly Defect[]): string {
  return document([
    ['kind', 'completeness'],
    ['request', 'none'],
    ['previous record', 'none'],
    ['defects', renderTable([...DEFECT_COLUMNS], defects.map(defectRow))],
  ]);
}
