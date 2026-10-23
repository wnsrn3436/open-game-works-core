import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { loadGameSettings, loadSchema, schemaPath, withDefaults } from '../../../lib/settings.ts';
import type { CsvTable } from '../../data/lib/csv.ts';
import { lineFile, type DataLine } from '../../data/api.ts';
import { glossaryCellMissing, translationLanguages, translationRowState, translationTable } from '../../data/lib/translation-state.ts';

export function translationPath(language: string): string {
  return `data/translations/${language}.csv`;
}

export const GLOSSARY_PATH = 'data/glossary.csv';

/**
 * Checks that `language` is in game settings `supportedLanguages` and is not `sourceLanguage`
 * (schema defaults filled in).
 */
export async function checkLanguage(ctx: Context, game: GameRepo, language: string): Promise<void> {
  const schema = await loadSchema(schemaPath('game-settings', ctx.env));
  const settings = withDefaults(schema, await loadGameSettings(game.root));
  const languages = translationLanguages(settings);
  if (!languages.includes(language)) {
    throw new OgwError(`${language} is not a translation language of ${game.name}: ${languages.join(', ') || 'none'}`);
  }
}

export async function readTable(root: string, path: string): Promise<CsvTable | null> {
  const full = join(root, path);
  return exists(full) ? translationTable(await readFile(full, 'utf8'), path) : null;
}

export interface GlossaryMatch {
  source: string;
  text: string;
}

export interface GlossaryGap {
  line: number;
  source: string;
  id_name: string;
  note: string;
}

export interface TranslationRow {
  key: string;
  source: string;
  glossary: GlossaryMatch[];
}

export interface StaleRow extends TranslationRow {
  text: string;
}

export interface Todo {
  glossary: GlossaryGap[];
  missing: TranslationRow[];
  stale: StaleRow[];
}

export function isStale(values: Record<string, string>): boolean {
  return translationRowState(values) === 'stale';
}

/** Glossary rows whose `source` the source text contains (case-sensitive), with their language cell. */
function matches(glossary: CsvTable | null, language: string, source: string): GlossaryMatch[] {
  if (glossary === null) return [];
  return glossary.rows
    .filter((row) => row.values.source !== '' && source.includes(row.values.source ?? ''))
    .map((row) => ({ source: row.values.source ?? '', text: row.values[language] ?? '' }));
}

/** Empty glossary cells, missing translations and stale translations of one language. */
function glossaryGaps(glossary: CsvTable | null, language: string): GlossaryGap[] {
  const gaps: GlossaryGap[] = [];
  for (const row of glossary?.rows ?? []) {
    if (!glossaryCellMissing(row.values, language)) continue;
    const { source = '', id_name = '', note = '' } = row.values;
    gaps.push({ line: row.line, source, id_name, note });
  }
  return gaps;
}

export function todoOf(translations: CsvTable | null, glossary: CsvTable | null, language: string): Todo {
  const todo: Todo = { glossary: glossaryGaps(glossary, language), missing: [], stale: [] };
  for (const { values } of translations?.rows ?? []) {
    const base = { key: values.key ?? '', source: values.source ?? '', glossary: matches(glossary, language, values.source ?? '') };
    const state = translationRowState(values);
    if (state === 'missing') todo.missing.push(base);
    else if (state === 'stale') todo.stale.push({ ...base, text: values.text ?? '' });
  }
  return todo;
}

/** A value as a JSON string literal, so that line breaks and separators inside it stay inside one output line. */
function quoted(value: string): string {
  return JSON.stringify(value);
}

function glossaryLines(matched: readonly GlossaryMatch[]): string[] {
  return matched.map((m) => `    glossary: ${quoted(m.source)} -> ${quoted(m.text)}`);
}

/** Text output: one line per item, every CSV value as a JSON string literal. */
export function formatTodo(todo: Todo): string {
  const out: string[] = [];
  for (const g of todo.glossary) {
    out.push(`glossary ${GLOSSARY_PATH}:${String(g.line)} source=${quoted(g.source)} id_name=${quoted(g.id_name)} note=${quoted(g.note)}`);
  }
  for (const row of todo.missing) out.push(`missing ${quoted(row.key)}`, `    source: ${quoted(row.source)}`, ...glossaryLines(row.glossary));
  for (const row of todo.stale) {
    out.push(`stale ${quoted(row.key)}`, `    source: ${quoted(row.source)}`, `    text: ${quoted(row.text)}`, ...glossaryLines(row.glossary));
  }
  return out.join('\n');
}

/** Data check lines about one of the given files. */
export function linesAbout(lines: readonly DataLine[], paths: readonly string[]): DataLine[] {
  return lines.filter((line) => {
    const file = lineFile(line).replace(/\\/g, '/');
    return paths.some((path) => file === path || file.endsWith(`/${path}`));
  });
}
