import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { exists } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { cell, column, parseTable, section, sectionText } from './markdown.ts';

export const SETUP_REQUEST = 'records/setup/request.md';
export const REFERENCE_DIR = 'records/setup/reference';
export const REFERENCE_FILE = `${REFERENCE_DIR}/reference.md`;
/** The game display name per language (`game-setup` 8): one `<language tag>: <name>` line per language. */
export const NAME_FILE = 'records/setup/name.md';
/** The art direction the person confirmed in `setup game` (`game-setup` 8). */
export const ART_DIRECTION_FILE = 'records/setup/art-direction.md';
/** Headings of `ART_DIRECTION_FILE`, each with text under it. */
export const ART_DIRECTION_HEADINGS = ['style', 'palette', 'mood'] as const;

/** The headings of `ART_DIRECTION_FILE` that are missing or empty; null when the file does not exist. */
export async function artDirectionGaps(game: GameRepo): Promise<string[] | null> {
  const path = join(game.root, ART_DIRECTION_FILE);
  if (!exists(path)) return null;
  const text = await readFile(path, 'utf8');
  return ART_DIRECTION_HEADINGS.filter((heading) => (sectionText(text, heading) ?? '') === '').map((heading) => `## ${heading}`);
}

/** Names of `records/setup/name.md` by language tag; null when the file does not exist. */
export async function readGameNames(game: GameRepo): Promise<Map<string, string> | null> {
  const path = join(game.root, NAME_FILE);
  if (!exists(path)) return null;
  const names = new Map<string, string>();
  for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
    const match = /^([A-Za-z0-9-]+):\s*(\S.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) names.set(match[1], match[2].trim());
  }
  return names;
}

export interface Moment {
  name: string;
  description: string;
}

/** The judge moment of `## memorable moment` of `brief.md` (`game-loop` `## sub-agent`). */
export const MEMORABLE_MOMENT = 'memorable_moment';

/** `` - `<name>`: <description> `` lines under `request.md` `## judge moments`; `(set by lead agent)` removed. */
export function judgeMoments(requestText: string): Moment[] {
  const lines = section(requestText, 'judge moments') ?? [];
  const moments: Moment[] = [];
  for (const line of lines) {
    const match = /^\s*-\s+`([^`]+)`(.*?):\s?(.*)$/.exec(line);
    if (!match) continue;
    const name = (match[1] as string).replace('(set by lead agent)', '').trim();
    moments.push({ name, description: (match[3] as string).trim() });
  }
  return moments;
}

export async function readJudgeMoments(game: GameRepo, requestRel: string): Promise<Moment[]> {
  const path = join(game.root, requestRel);
  if (!exists(path)) return [];
  return judgeMoments(await readFile(path, 'utf8'));
}

/**
 * The judge moments of a fun iteration: the `## judge moments` moment that the `- moment:` line of `## hypothesis` of
 * the content agent report names (`agents/content.md` `## report`); none when the report or the line is missing or names
 * no moment of `request.md`.
 */
export async function hypothesisMoments(game: GameRepo, requestRel: string, reportRel: string): Promise<Moment[]> {
  const path = join(game.root, reportRel);
  if (!exists(path)) return [];
  const lines = section(await readFile(path, 'utf8'), 'hypothesis') ?? [];
  const name = lines.map((line) => /^- moment: `?([^`]+?)`?\s*$/.exec(line.trim())?.[1]).find((n) => n !== undefined);
  if (name === undefined) return [];
  return (await readJudgeMoments(game, requestRel)).filter((m) => m.name === name);
}

export interface ReferenceMoment {
  name: string;
  /** Absolute path of the video the moment is in; null when no video has it. */
  video: string | null;
  startMs: number | null;
  endMs: number | null;
}

export interface Reference {
  name: string;
  /** `## presentation game`: the game the screen moments are from; `name` when the file has none. */
  presentation: string;
  /** Absolute paths of the gameplay videos in `## video` order. */
  videos: string[];
  /** File names in `## video` that are not in the folder. */
  missingVideos: string[];
  moments: ReferenceMoment[];
}

function formatError(what: string): OgwError {
  return new OgwError(`${REFERENCE_FILE} ${what} is not in the format of game-setup 8`);
}

/** A `start ms` or `end ms` cell: a non-negative integer, or `none` (null). */
function msCell(text: string): number | null {
  const t = text.trim();
  if (t === 'none') return null;
  if (!/^\d+$/.test(t)) throw formatError(`\`## moments\` cell "${t}"`);
  return Number(t);
}

/** `## video`: one file name of the reference folder per line, at least one, no repeats. */
export function referenceVideoNames(text: string): string[] {
  const names = (section(text, 'video') ?? []).map((line) => line.trim()).filter((line) => line !== '');
  if (names.length === 0 || names.some((name) => /[/\\]/.test(name)) || new Set(names).size !== names.length) {
    throw formatError('`## video`');
  }
  return names;
}

/**
 * `## moments` table rows: `moment`, `video`, `start ms`, `end ms`. `video` is a `## video` file name, or `none`
 * with both ms cells `none`. The returned `video` is the file name (null for `none`).
 */
export function referenceMoments(text: string, videos: readonly string[]): ReferenceMoment[] {
  const table = parseTable(section(text, 'moments') ?? []);
  if (!table) throw formatError('`## moments`');
  const [nameCol, videoCol, startCol, endCol] = ['moment', 'video', 'start ms', 'end ms'].map((name) => column(table, name)) as [number, number, number, number];
  if (nameCol < 0 || videoCol < 0 || startCol < 0 || endCol < 0) throw formatError('`## moments` header');
  return table.rows.map((row) => {
    const video = cell(row, videoCol).trim();
    const startMs = msCell(cell(row, startCol));
    const endMs = msCell(cell(row, endCol));
    const none = video === 'none';
    if (!none && !videos.includes(video)) throw formatError(`\`## moments\` video "${video}"`);
    if (none !== (startMs === null) || none !== (endMs === null)) throw formatError(`\`## moments\` row "${cell(row, nameCol)}"`);
    return { name: cell(row, nameCol), video: none ? null : video, startMs, endMs };
  });
}

export async function readReference(game: GameRepo): Promise<Reference | null> {
  const path = join(game.root, REFERENCE_FILE);
  if (!exists(path)) return null;
  const text = await readFile(path, 'utf8');
  const names = referenceVideoNames(text);
  const pathOf = (name: string): string => join(game.root, REFERENCE_DIR, name);
  return {
    name: sectionText(text, 'game') ?? '',
    presentation: sectionText(text, 'presentation game') ?? sectionText(text, 'game') ?? '',
    videos: names.map(pathOf),
    missingVideos: names.filter((name) => !exists(pathOf(name))),
    moments: referenceMoments(text, names).map((moment) => ({ ...moment, video: moment.video === null ? null : pathOf(moment.video) })),
  };
}

/**
 * The reference, for a loop start and before any judge agent is called. Fails when `REFERENCE_FILE` is missing or a
 * `## video` file is not in `REFERENCE_DIR`: gameplay videos are not committed, so a checkout has only the videos put on this host.
 */
export async function requireReference(game: GameRepo): Promise<Reference> {
  const reference = await readReference(game);
  if (!reference) throw new OgwError(`${REFERENCE_FILE} is missing`);
  const missing = reference.missingVideos;
  if (missing.length > 0) {
    throw new OgwError(
      `${REFERENCE_DIR}/ lacks the gameplay videos that ${REFERENCE_FILE} \`## video\` names: ${missing.join(', ')}. ` +
        `Gameplay videos are not committed: put each file in ${REFERENCE_DIR}/, or fetch it with ogw game reference ${game.name} <YouTube URL>, which saves <YouTube video id>.mp4`,
      1,
      { missingVideos: missing },
    );
  }
  return reference;
}
