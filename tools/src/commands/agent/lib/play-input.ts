import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readText, writeJsonAtomic } from '../../../lib/fsx.ts';
import { extensionOf } from '../../../lib/paths.ts';

interface PathField {
  path: [string, string] | [string];
  name: (source: string) => string;
}

/** Path fields of the play and judge input that are copied into `input/`, with the copied names. */
const PATH_FIELDS: Record<'play' | 'judge', PathField[]> = {
  play: [{ path: ['playGuide'], name: () => 'play-guide.md' }],
  judge: [
    { path: ['A', 'playGuide'], name: () => 'play-guide-A.md' },
    { path: ['B', 'playGuide'], name: () => 'play-guide-B.md' },
    { path: ['telemetry'], name: () => 'telemetry.md' },
  ],
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The object holding the field, or null when a part of the path is missing. */
function holder(input: Json, path: readonly string[]): Json | null {
  let current: Json = input;
  for (const part of path.slice(0, -1)) {
    const next = current[part];
    if (!isObject(next)) return null;
    current = next;
  }
  return current;
}

/** The instances of a play or judge input: `instance` of play; `A`, `B` and the fixture pairs of judge. */
export function instanceIds(role: 'play' | 'judge', input: Json): string[] {
  const ids: unknown[] = [];
  if (role === 'play') ids.push(input.instance);
  else {
    for (const side of ['A', 'B']) {
      const game = input[side];
      if (isObject(game)) ids.push(game.instance);
    }
    const fixtures = input.fixtures;
    if (Array.isArray(fixtures)) {
      for (const fixture of fixtures as unknown[]) if (isObject(fixture)) ids.push(fixture.A, fixture.B);
    }
  }
  return [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
}

export interface PreparedPlayInput {
  /** `input/input.json` in the folder. */
  input: string;
  instances: string[];
}

/**
 * Copies each `reference.moments[].video` file as `reference-video-<k>` plus its extension, `<k>` from 1 in the order
 * the files first appear, and points the moments at the copies. Moments of the same file share one copy.
 */
async function copyReferenceVideos(input: Json, givenInput: string, inputDir: string): Promise<void> {
  const reference = input.reference;
  if (!isObject(reference) || !Array.isArray(reference.moments)) return;
  const copies = new Map<string, string>();
  for (const moment of reference.moments as unknown[]) {
    if (!isObject(moment) || moment.video === null || moment.video === undefined) continue;
    if (typeof moment.video !== 'string') throw new OgwError('judge input reference.moments video is not a path');
    const source = resolve(dirname(givenInput), moment.video);
    let copied = copies.get(source);
    if (copied === undefined) {
      if (!exists(source)) throw new OgwError(`judge input reference.moments video: file not found: ${source}`);
      copied = join(inputDir, `reference-video-${String(copies.size + 1)}${extensionOf(source)}`);
      await copyFile(source, copied);
      copies.set(source, copied);
    }
    moment.video = copied;
  }
}

/**
 * Copies the files the path fields point at into `<folder>/input/` and writes `<folder>/input/input.json`
 * with only those field values changed to the copied files. Fails when the input is not JSON or a file is missing.
 */
export async function preparePlayInput(role: 'play' | 'judge', givenInput: string, folder: string): Promise<PreparedPlayInput> {
  let input: unknown;
  try {
    input = JSON.parse(await readText(givenInput));
  } catch (error) {
    if (error instanceof OgwError && error.message.startsWith('file not found')) throw error;
    throw new OgwError(`${role} input is not JSON: ${givenInput}`);
  }
  if (!isObject(input)) throw new OgwError(`${role} input is not a JSON object: ${givenInput}`);
  const inputDir = join(folder, 'input');
  await mkdir(inputDir, { recursive: true });
  for (const field of PATH_FIELDS[role]) {
    const parent = holder(input, field.path);
    const key = field.path[field.path.length - 1] as string;
    if (!parent || !(key in parent)) continue;
    const value = parent[key];
    if (value === null) continue;
    if (typeof value !== 'string') throw new OgwError(`${role} input ${field.path.join('.')} is not a path`);
    const source = resolve(dirname(givenInput), value);
    if (!exists(source)) throw new OgwError(`${role} input ${field.path.join('.')}: file not found: ${source}`);
    const copied = join(inputDir, field.name(source));
    await copyFile(source, copied);
    parent[key] = copied;
  }
  if (role === 'judge') await copyReferenceVideos(input, givenInput, inputDir);
  const path = join(inputDir, 'input.json');
  await writeJsonAtomic(path, input);
  return { input: path, instances: instanceIds(role, input) };
}
