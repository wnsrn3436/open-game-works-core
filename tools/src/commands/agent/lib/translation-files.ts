import { basename } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { git, showFile, type GitOptions } from '../../../lib/git.ts';
import type { TranslationFiles } from './rowmerge.ts';

export const GLOSSARY = 'data/glossary.csv';
export const RESOURCES = 'resource/resources.csv';
export const TRANSLATIONS_DIR = 'data/translations/';

/** `data/translations/<language>.csv` paths at a commit. */
export async function translationPaths(repo: string, commit: string, options: GitOptions = {}): Promise<string[]> {
  const listed = await git(repo, ['ls-tree', '--name-only', commit, TRANSLATIONS_DIR], options);
  return listed.split('\n').filter((path) => path.startsWith(TRANSLATIONS_DIR) && path.endsWith('.csv'));
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The text of CSV bytes (`data` skill `## CSV format`: UTF-8), BOM kept; bytes that are not UTF-8 throw `OgwError`. */
export function utf8Text(bytes: Buffer): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new OgwError('not UTF-8');
  }
}

/** The text of a file at a commit: null when it has none, `undefined` when it is not UTF-8. */
async function textAt(repo: string, commit: string, path: string, options: GitOptions): Promise<string | null | undefined> {
  const bytes = await showFile(repo, commit, path, options);
  if (bytes === null) return null;
  try {
    return utf8Text(bytes);
  } catch {
    return undefined;
  }
}

/** Translation files and the glossary at a commit. */
export async function readTranslationFiles(repo: string, commit: string, options: GitOptions = {}): Promise<TranslationFiles> {
  const translations = new Map<string, string | undefined>();
  for (const path of await translationPaths(repo, commit, options)) {
    const text = await textAt(repo, commit, path, options);
    if (text !== null) translations.set(basename(path, '.csv'), text);
  }
  return { translations, glossary: await textAt(repo, commit, GLOSSARY, options) };
}
