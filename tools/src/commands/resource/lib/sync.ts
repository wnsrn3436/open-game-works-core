import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import type { GameSettings } from '../../../lib/settings.ts';
import { FileChanges } from './files.ts';
import { engineOf, gameSettings, lineVoices, sourceLanguageOf, sourceTranslations, type TranslationRow } from './gamedata.ts';
import { classProblem, engineType, type EngineType } from './godot.ts';
import {
  ALWAYS_FINAL,
  COLUMNS,
  emptyRow,
  findRow,
  formatList,
  keyFiles,
  LIST_PATH,
  listSha,
  parseKey,
  readList,
  MADE,
  STATUSES,
  type KeyFile,
  type ParsedKey,
  type ResourceRow,
} from './list.ts';
import { hostTools, placeholderFiles, type Tools } from './placeholder.ts';
import { parseSpec, specProblems, type Spec } from './spec.ts';

export interface SyncResult {
  /** Files written or deleted, relative to the checkout. */
  files: string[];
  /** Rows whose cells changed, with the changed cells' new values. */
  rows: { key: string; changed: Partial<ResourceRow> }[];
  /** Restores every file the sync changed. */
  undo: () => Promise<void>;
}

/** Adds the platform rows when missing and sets their `spec` to the defined value. */
function platformRows(rows: ResourceRow[], settings: GameSettings): void {
  const resolution = settings.baseResolution;
  if (!Array.isArray(resolution) || resolution.length !== 2) throw new OgwError('game settings has no baseResolution for splash/main');
  const specs: [string, string][] = [
    ['app_icon/main', 'size=1024x1024'],
    ['splash/main', `size=${String(resolution[0])}x${String(resolution[1])}`],
  ];
  for (const [key, spec] of specs) {
    let row = findRow(rows, key);
    if (!row) {
      row = emptyRow(key);
      row.status = 'placeholder';
      rows.push(row);
    }
    row.spec = spec;
  }
}

function clearFinal(row: ResourceRow): void {
  row.status = 'placeholder';
  row.method = '';
  row.source = '';
  row.license = '';
  row.attribution = '';
  row.text_hash = '';
}

/** Writes the `text_key` and `speaker` cells of the line voice rows from the `cutscene_step` `voice` cells. */
export function writeLineVoices(rows: readonly ResourceRow[], voices: Awaited<ReturnType<typeof lineVoices>>): void {
  for (const voice of voices) {
    const row = findRow(rows, voice.voice);
    if (!row) continue;
    row.text_key = voice.textKey;
    row.speaker = voice.speaker;
  }
}

/** Writes line voice cells, checks text voice `text_key`, and reverts final text voices whose text changed. */
function textVoices(rows: ResourceRow[], voices: Awaited<ReturnType<typeof lineVoices>>, translations: Map<string, TranslationRow>, language: string): string[] {
  const problems: string[] = [];
  writeLineVoices(rows, voices);
  for (const row of rows) {
    if (parseKey(row.key)?.type !== 'voice' || row.text_key === '') continue;
    const translation = translations.get(row.text_key);
    if (!translation) {
      problems.push(`${row.key}: text_key ${row.text_key} is not in data/translations/${language}.csv`);
      continue;
    }
    if (row.status === 'final' && translation.currentHash !== row.text_hash) clearFinal(row);
  }
  return problems;
}

function fileProblem(key: string, entry: EngineType, spec: Spec, files: readonly KeyFile[]): string | null {
  if (files.length === 0) return `${key}: no file resource/${key}.<extension>`;
  for (const file of files) {
    if (!entry.extensions.includes(file.extension)) return `${key}: ${file.path} extension is not ${entry.extensions.join(' or ')}`;
  }
  if (spec.variants >= 2) {
    const numbers = files.map((f) => f.variant);
    const expected = Array.from({ length: spec.variants }, (_, i) => i + 1);
    if (numbers.join(',') !== expected.join(',')) return `${key}: variants=${String(spec.variants)} needs files ${expected.map((n) => `resource/${key}.${String(n)}.<extension>`).join(', ')}, found ${files.map((f) => f.path).join(', ')}`;
    return null;
  }
  if (files.length !== 1 || files[0]?.variant !== null) return `${key}: needs one file resource/${key}.<extension>, found ${files.map((f) => f.path).join(', ')}`;
  return null;
}

interface RowContext {
  root: string;
  engine: string;
  tools: Tools;
  changes: FileChanges;
  problems: string[];
}

async function existingFiles(c: RowContext, row: ResourceRow, parsed: ParsedKey, spec: Spec, files: readonly KeyFile[]): Promise<Buffer[] | null> {
  const entry = engineType(c.engine, parsed.type);
  const problem = fileProblem(row.key, entry, spec, files);
  if (problem !== null) {
    c.problems.push(problem);
    return null;
  }
  const data: Buffer[] = [];
  for (const file of files) {
    const bytes = await readFile(join(c.root, file.path));
    const classIssue = classProblem(entry, spec, file.extension, bytes.toString('utf8'));
    if (classIssue !== null) {
      c.problems.push(`${row.key}: ${file.path} ${classIssue}`);
      return null;
    }
    data.push(bytes);
  }
  return data;
}

async function syncRow(c: RowContext, row: ResourceRow): Promise<void> {
  const parsed = parseKey(row.key);
  if (!parsed) {
    c.problems.push(`${row.key}: invalid resource key`);
    return;
  }
  if (!STATUSES.includes(row.status)) {
    c.problems.push(`${row.key}: invalid status ${row.status}`);
    return;
  }
  const issues = specProblems(parsed.type, row.spec);
  if (issues.length > 0) {
    c.problems.push(`${row.key}: spec ${row.spec === '' ? '(empty)' : row.spec}: ${issues.join('; ')}`);
    return;
  }
  if (ALWAYS_FINAL.includes(parsed.type) && row.status !== 'final') {
    c.problems.push(`${row.key}: type ${parsed.type} must be final`);
    return;
  }
  const spec = parseSpec(row.key, parsed.type, row.spec);
  const files = await keyFiles(c.root, row.key);
  let data: Buffer[] | null;
  // until `ogw resource finalize` writes the final file and `final` together, the files are the tool's placeholder
  if (!MADE.includes(row.status)) {
    const made = await placeholderFiles(c.engine, row.key, parsed, spec, c.tools);
    for (const file of files) if (!made.some((m) => m.path === file.path)) c.changes.delete(file.path);
    for (const file of made) c.changes.write(file.path, file.data);
    data = made.map((m) => m.data);
  } else {
    data = await existingFiles(c, row, parsed, spec, files);
  }
  if (data) row.sha256 = listSha(data);
}

function changedRows(before: readonly ResourceRow[], after: readonly ResourceRow[]): SyncResult['rows'] {
  const result: SyncResult['rows'] = [];
  for (const row of after) {
    const old = findRow(before, row.key);
    const changed: Partial<ResourceRow> = {};
    for (const column of COLUMNS) if (old?.[column] !== row[column]) changed[column] = row[column];
    if (Object.keys(changed).length > 0) result.push({ key: row.key, changed });
  }
  return result;
}

/**
 * `ogw resource sync` and `ogw resource placeholder` on the checkout `game.root`
 * (`resource` skill `## resource list` and `## placeholder resource`). Fails without changing anything when a row breaks a rule.
 */
export async function runSync(ctx: Context, game: GameRepo, tools: Tools = hostTools(ctx)): Promise<SyncResult> {
  const settings = await gameSettings(ctx, game);
  const engine = engineOf(settings);
  const language = sourceLanguageOf(settings);
  const original = await readList(game.root);
  const rows = original.map((row) => ({ ...row }));
  platformRows(rows, settings);
  const problems = textVoices(rows, await lineVoices(game.root), await sourceTranslations(game.root, language), language);
  const c: RowContext = { root: game.root, engine, tools, changes: new FileChanges(), problems };
  for (const row of rows) await syncRow(c, row);
  if (problems.length > 0) throw new OgwError(problems.join('\n'));
  c.changes.write(LIST_PATH, formatList(rows));
  const { changed, undo } = await c.changes.apply(game.root);
  return { files: changed, rows: changedRows(original, rows), undo };
}

export function syncText(result: SyncResult): string {
  const lines = result.rows.map((r) => `${r.key} ${Object.entries(r.changed).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  lines.push(...result.files.map((f) => `changed ${f}`));
  return lines.length > 0 ? lines.join('\n') : 'no change';
}
