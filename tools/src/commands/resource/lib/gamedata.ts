import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { isNotFound } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { loadGameSettings, loadSchema, schemaPath, withDefaults, type GameSettings } from '../../../lib/settings.ts';
import { parseTable } from './csv.ts';

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Game settings of the checkout with schema defaults filled in. */
export async function gameSettings(ctx: Context, game: GameRepo): Promise<GameSettings> {
  const schema = await loadSchema(schemaPath('game-settings', ctx.env));
  return withDefaults(schema, await loadGameSettings(game.root));
}

export function engineOf(settings: GameSettings): string {
  if (typeof settings.engine !== 'string') throw new OgwError('game settings has no engine');
  return settings.engine;
}

export function sourceLanguageOf(settings: GameSettings): string {
  if (typeof settings.sourceLanguage !== 'string') throw new OgwError('game settings has no sourceLanguage');
  return settings.sourceLanguage;
}

export interface TranslationRow {
  source: string;
  currentHash: string;
}

/** Rows of the source language translation file by translation key. A missing file has no rows. */
export async function sourceTranslations(root: string, language: string): Promise<Map<string, TranslationRow>> {
  const path = `data/translations/${language}.csv`;
  const text = await readIfExists(join(root, path));
  const rows = new Map<string, TranslationRow>();
  if (text === null) return rows;
  const table = parseTable(text, path);
  for (const column of ['key', 'source', 'current_hash']) {
    if (!table.header.includes(column)) throw new OgwError(`${path}: no column ${column}`);
  }
  for (const record of table.records) {
    rows.set(record.key as string, { source: record.source as string, currentHash: record.current_hash as string });
  }
  return rows;
}

export interface LineVoice {
  voice: string;
  textKey: string;
  speaker: string;
}

function idInner(cell: string): string {
  const match = /^\[(.*)\]$/.exec(cell);
  return match ? (match[1] as string) : cell;
}

/** `cutscene_step` rows whose `voice` is not `null`: the voice key, the `text` translation key, and the speaker name. */
export async function lineVoices(root: string): Promise<LineVoice[]> {
  const path = 'data/tables/cutscene_step.csv';
  const text = await readIfExists(join(root, path));
  if (text === null) return [];
  const table = parseTable(text, path, 4);
  for (const column of ['id', 'step', 'speaker', 'voice']) {
    if (!table.header.includes(column)) throw new OgwError(`${path}: no column ${column}`);
  }
  const voices: LineVoice[] = [];
  for (const record of table.records) {
    const id = record.id as string;
    const voice = record.voice as string;
    if (id.startsWith('#') || voice === 'null' || voice === '') continue;
    const speaker = record.speaker as string;
    voices.push({
      voice,
      textKey: `cutscene_step.text.${id}.${record.step as string}`,
      speaker: speaker === 'null' ? 'none' : idInner(speaker),
    });
  }
  return voices;
}
