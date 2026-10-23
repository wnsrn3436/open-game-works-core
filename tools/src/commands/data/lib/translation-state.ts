/**
 * Translation state shared by `ogw check` (no placeholder) and `ogw translation` (`data` skill `## translation`).
 */
import { parseTable, type CsvTable } from './csv.ts';

/** Languages that need translation: `supportedLanguages` without `sourceLanguage` (game settings with schema defaults). */
export function translationLanguages(settings: { supportedLanguages?: unknown; sourceLanguage?: unknown }): string[] {
  const supported: unknown[] = Array.isArray(settings.supportedLanguages) ? settings.supportedLanguages : [];
  return supported.filter((l): l is string => typeof l === 'string' && l !== settings.sourceLanguage);
}

/**
 * Reads a translation file or the glossary: a one-line header CSV whose blank lines (every field empty) are not rows.
 * The one reader of both files for `ogw check` and `ogw translation`. Throws `OgwError` on malformed CSV
 * (for example an unclosed quote).
 */
export function translationTable(text: string, file: string): CsvTable {
  const table = parseTable(text, file);
  return { ...table, rows: table.rows.filter((row) => Object.values(row.values).some((value) => value !== '')) };
}

/** A translation file row: `missing` (`text` empty), `stale` (`text` set and `source_hash` ≠ `current_hash`), or null. */
export function translationRowState(values: Readonly<Record<string, string | undefined>>): 'missing' | 'stale' | null {
  if ((values.text ?? '') === '') return 'missing';
  return values.source_hash !== values.current_hash ? 'stale' : null;
}

/** True when the glossary row's `<language>` cell is empty: a missing translation of that language. */
export function glossaryCellMissing(values: Readonly<Record<string, string | undefined>>, language: string): boolean {
  return (values[language] ?? '') === '';
}
