import type { Context } from '../../lib/command.ts';
import type { GameRepo } from '../../lib/game.ts';
import { showFile } from '../../lib/git.ts';
import { loadSchema, schemaPath, withDefaults } from '../../lib/settings.ts';
import { OgwError } from '../../lib/errors.ts';
import type { CsvRow } from '../data/lib/csv.ts';
import { glossaryCellMissing, translationLanguages, translationRowState, translationTable } from '../data/lib/translation-state.ts';

/** `<failure>` of `check-<iteration>.json` (`game-loop` `## loop iteration record`). */
export interface CheckFailure {
  where: string;
  message: string;
  evidence: string[];
}

export interface HostLoad {
  cpuMaxPercent: number;
  memoryMaxPercent: number;
  instancesMax: number;
}

export interface CheckResult {
  name: string;
  platform: string | null;
  result: 'pass' | 'fail' | 'unknown';
  failures: CheckFailure[];
  warnings: CheckFailure[];
  hostLoad?: HostLoad;
}

/** Check names in the order of `check-<iteration>.json`. */
export const CHECK_ORDER: readonly string[] = [
  'regression test',
  'static check',
  'no blocker',
  'full flow',
  'performance',
  'UI quality',
  'no placeholder',
  'row simulation',
];

/** The four checks whose `result` decides `gate`. */
export const GATE_CHECKS: readonly string[] = ['regression test', 'static check', 'no blocker', 'full flow'];

/** One result of a check from its items (one per platform profile): any `fail` is `fail`, all `pass` is `pass`, else `unknown`. */
export function mergedResult(items: readonly CheckResult[]): CheckResult['result'] {
  if (items.some((c) => c.result === 'fail')) return 'fail';
  return items.length > 0 && items.every((c) => c.result === 'pass') ? 'pass' : 'unknown';
}

/** One `{name, result}` per check name, in the order the names first appear. */
export function mergedChecks(checks: readonly CheckResult[]): { name: string; result: CheckResult['result'] }[] {
  const names = [...new Set(checks.map((c) => c.name))];
  return names.map((name) => ({ name, result: mergedResult(checks.filter((c) => c.name === name)) }));
}

const RESOURCES = 'resource/resources.csv';
const GLOSSARY = 'data/glossary.csv';

async function headText(game: GameRepo, path: string): Promise<string | null> {
  const bytes = await showFile(game.root, 'HEAD', path);
  return bytes === null ? null : bytes.toString('utf8');
}

function failure(where: string, message: string): CheckFailure {
  return { where, message, evidence: [] };
}

/** Rows of a header-1-row CSV through the reader `ogw translation` uses (`translationTable`), or the read error. */
function headerRows(text: string, path: string): { rows: CsvRow[] } | { error: string } {
  try {
    return { rows: translationTable(text, path).rows };
  } catch (error) {
    if (error instanceof OgwError) return { error: error.message };
    throw error;
  }
}

/**
 * Rows of `resource/resources.csv` whose `status` is not `final` hold a placeholder resource. An unreadable file is one
 * failure at its line 1: no row of it can be shown final.
 */
async function placeholderResources(game: GameRepo): Promise<CheckFailure[]> {
  const text = await headText(game, RESOURCES);
  if (text === null) return [];
  const read = headerRows(text, RESOURCES);
  if ('error' in read) return [failure(`${RESOURCES}:1`, `placeholder resource list unreadable: ${read.error}`)];
  return read.rows
    .filter((row) => row.values.status !== 'final')
    .map((row) => failure(`${RESOURCES}:${String(row.line)}`, `placeholder ${row.values.key ?? ''}`));
}

/** Missing translation (`text` empty) and stale translation (`source_hash` ≠ `current_hash`) of one language. */
async function translationFailures(game: GameRepo, language: string): Promise<CheckFailure[]> {
  const path = `data/translations/${language}.csv`;
  const text = await headText(game, path);
  if (text === null) return [failure(`${path}:1`, `translation_missing ${language} file missing`)];
  const read = headerRows(text, path);
  if ('error' in read) return [failure(`${path}:1`, `translation_missing ${language} file unreadable: ${read.error}`)];
  const failures: CheckFailure[] = [];
  for (const row of read.rows) {
    const where = `${path}:${String(row.line)}`;
    const key = row.values.key ?? '';
    const state = translationRowState(row.values);
    if (state !== null) failures.push(failure(where, `translation_${state} ${language} ${key}`));
  }
  return failures;
}

/** Glossary rows whose `<language>` cell is empty are missing translations of that language. */
async function glossaryFailures(game: GameRepo, languages: readonly string[]): Promise<CheckFailure[]> {
  const text = await headText(game, GLOSSARY);
  if (text === null) return [];
  const read = headerRows(text, GLOSSARY);
  if ('error' in read) {
    return languages.map((language) => failure(`${GLOSSARY}:1`, `translation_missing ${language} glossary unreadable: ${read.error}`));
  }
  const failures: CheckFailure[] = [];
  for (const row of read.rows) {
    for (const language of languages) {
      if (!glossaryCellMissing(row.values, language)) continue;
      failures.push(failure(`${GLOSSARY}:${String(row.line)}`, `translation_missing ${language} glossary ${row.values.source ?? ''}`));
    }
  }
  return failures;
}

/** Languages that need translation: game settings (at HEAD) `supportedLanguages` without `sourceLanguage`. */
async function targetLanguages(ctx: Context, game: GameRepo): Promise<string[]> {
  const text = await headText(game, 'settings.json');
  if (text === null) return [];
  const schema = await loadSchema(schemaPath('game-settings', ctx.env));
  const settings = withDefaults(schema, JSON.parse(text) as { supportedLanguages?: unknown; sourceLanguage?: unknown });
  return translationLanguages(settings);
}

/** no placeholder: one failure per placeholder resource, missing translation, stale translation, at HEAD of the checkout. */
export async function placeholderFailures(ctx: Context, game: GameRepo): Promise<CheckFailure[]> {
  const languages = await targetLanguages(ctx, game);
  const failures = await placeholderResources(game);
  for (const language of languages) failures.push(...(await translationFailures(game, language)));
  failures.push(...(await glossaryFailures(game, languages)));
  return failures;
}

/** Row simulation calculation shared with `ogw simulate` (runner group). */
export { rowSimulationFailures, simulateRows, type RowResult, type RowSimulation, type SimulateOptions, type Verdict } from './lib/row-simulation.ts';
/** `UnitTestCore` test host, shareable with `ogw core test`. */
export { startTestHost, type TestHost, type TestInput } from './lib/test-host.ts';
