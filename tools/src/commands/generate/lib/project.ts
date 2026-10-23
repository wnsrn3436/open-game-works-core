import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { exists } from '../../../lib/fsx.ts';
import type { GameSettings } from '../../../lib/settings.ts';
import { parseCsv, parseTable } from '../../data/lib/csv.ts';
import type { CfgEntry } from './godot-cfg.ts';
import { checkContentSettings, renderProjectGodot } from './godot-project.ts';

async function readIfExists(path: string): Promise<string | null> {
  return exists(path) ? readFile(path, 'utf8') : null;
}

/** Source text of reserved string `[app_name]` in `data/system/reserved_string.csv` (4 header rows). */
export async function appNameSource(root: string): Promise<string> {
  const file = join(root, 'data', 'system', 'reserved_string.csv');
  const text = await readIfExists(file);
  if (text === null) return '';
  const records = parseCsv(text, file);
  const names = records[3]?.fields ?? [];
  const id = names.indexOf('id');
  const column = names.indexOf('text');
  const row = records.slice(4).find((r) => r.fields[id] === '[app_name]');
  return row?.fields[column] ?? '';
}

const APP_NAME_KEY = 'reserved_string.text.[app_name]';

/** The app name per supported language: its translation, or the source text when the translation is missing. */
export async function localizedAppNames(root: string, languages: readonly string[], source: string): Promise<[string, string][]> {
  const result: [string, string][] = [];
  for (const language of languages) {
    const file = join(root, 'data', 'translations', `${language}.csv`);
    const text = await readIfExists(file);
    const row = text === null ? undefined : parseTable(text, file).rows.find((r) => r.values.key === APP_NAME_KEY);
    const translated = row?.values.text ?? '';
    result.push([language.replaceAll('-', '_'), translated !== '' ? translated : source]);
  }
  return result;
}

function baseResolution(settings: GameSettings): [number, number] {
  const value = settings.baseResolution;
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => Number.isInteger(n))) {
    throw new OgwError('game settings baseResolution is missing or invalid');
  }
  return [value[0] as number, value[1] as number];
}

/** Checked entries of `client/boot/project_settings.cfg`; none when the file is absent. */
export async function contentSettings(root: string): Promise<CfgEntry[]> {
  const text = await readIfExists(join(root, 'client', 'boot', 'project_settings.cfg'));
  return text === null ? [] : checkContentSettings(text, 'client/boot/project_settings.cfg');
}

/** `client/project.godot` of the checkout. */
export async function projectGodot(root: string, settings: GameSettings, content: readonly CfgEntry[]): Promise<string> {
  const appName = await appNameSource(root);
  return renderProjectGodot(
    {
      appName,
      localizedNames: await localizedAppNames(root, settings.supportedLanguages ?? [], appName),
      iconPath: 'res://resource/app_icon/main.png',
      splashPath: 'res://resource/splash/main.png',
      baseResolution: baseResolution(settings),
    },
    content,
  );
}
