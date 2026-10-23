import { OgwError } from '../../../lib/errors.ts';

export interface ImportResult {
  replacedRecords: number;
  dataVersionMatches: boolean;
  dataVersion: string;
}

/** The clone result part of a record line: `replaced_records <n>, data_version_matches <b>[, ...]`. */
export function resultLine(result: ImportResult, snapshotDataVersion: string, targetLabel: string): string {
  const base = `replaced_records ${String(result.replacedRecords)}, data_version_matches ${String(result.dataVersionMatches)}`;
  if (result.dataVersionMatches) return base;
  return `${base}, snapshot data_version ${snapshotDataVersion}, ${targetLabel} data_version ${result.dataVersion}`;
}

/** Reads the output of `import_user_snapshot` and `import_game_state`. */
export function importResult(body: unknown): ImportResult {
  const output = body as Record<string, unknown> | null;
  const replaced = output?.replaced_records;
  const matches = output?.data_version_matches;
  const dataVersion = output?.data_version;
  if (typeof replaced !== 'number' || typeof matches !== 'boolean' || typeof dataVersion !== 'string') {
    throw new OgwError(`import answered an unexpected body: ${JSON.stringify(body)}`);
  }
  return { replacedRecords: replaced, dataVersionMatches: matches, dataVersion };
}
