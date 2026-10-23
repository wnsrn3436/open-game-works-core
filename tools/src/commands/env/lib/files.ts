import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { isInside } from '../../../lib/paths.ts';
import { runOk } from '../../../lib/proc.ts';
import { byteCompare } from '../../../lib/order.ts';
import { hostPlatform } from './host.ts';
import { net } from './net.ts';

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * File name of a download URL: the last path segment without the query, URL-decoded. Fails when the
 * decoded name is not a plain file name (`/`, `\`, NUL, `.` or `..`).
 */
export function urlFileName(url: string): string {
  const path = new URL(url).pathname;
  const segment = path.slice(path.lastIndexOf('/') + 1);
  let name: string;
  try {
    name = decodeURIComponent(segment);
  } catch {
    throw new OgwError(`download URL has an undecodable file name: ${url}`);
  }
  if (name === '') return 'download';
  if (/[/\\\0]/.test(name) || name === '.' || name === '..') throw new OgwError(`download URL file name is not a plain file name: ${url}`);
  return name;
}

export interface Mismatch {
  /** What was pinned: a URL, a pin source, or a file path. */
  what: string;
  path: string;
  expected: string;
  actual: string;
}

/** Downloads `url` into `dir` and compares its SHA-256. Returns the file path and the mismatch, if any. */
export async function downloadChecked(url: string, sha256: string, dir: string): Promise<{ file: string; mismatch: Mismatch | null }> {
  const file = join(dir, urlFileName(url));
  if (!isInside(dir, file)) throw new OgwError(`download URL file name leaves the download folder: ${url}`);
  await net().download(url, file);
  const actual = await sha256File(file);
  return { file, mismatch: actual === sha256 ? null : { what: url, path: file, expected: sha256, actual } };
}

export function archiveKind(file: string): 'zip' | 'tar' | 'dmg' | null {
  const name = file.toLowerCase();
  if (name.endsWith('.zip') || name.endsWith('.tpz')) return 'zip';
  if (/\.(tar|tar\.gz|tgz|tar\.xz|txz|tar\.bz2)$/.test(name)) return 'tar';
  if (name.endsWith('.dmg')) return 'dmg';
  return null;
}

/** Extracts an archive into `dir`. A `.dmg` is attached read-only and its top-level entries are copied. */
export async function extractArchive(file: string, dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  await mkdir(dir, { recursive: true });
  const kind = archiveKind(file);
  const options = { env, timeoutMs: LIMITS.programMs };
  if (kind === 'zip') {
    if (hostPlatform(env) === 'windows-x64') await runOk('tar', ['-xf', file, '-C', dir], options);
    else await runOk('unzip', ['-q', '-o', file, '-d', dir], options);
    return;
  }
  if (kind === 'tar') {
    await runOk('tar', ['-xf', file, '-C', dir], options);
    return;
  }
  if (kind === 'dmg') {
    await extractDmg(file, dir, env);
    return;
  }
  throw new OgwError(`not an archive: ${file}`);
}

async function extractDmg(file: string, dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const mount = await mkdtemp(join(dir, '.mount-'));
  const options = { env, timeoutMs: LIMITS.programMs };
  await runOk('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, file], options);
  try {
    // links such as the /Applications shortcut (named " " in the Blender dmg) point outside the image: ditto would copy their target
    for (const entry of await readdir(mount, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      await runOk('ditto', [join(mount, entry.name), join(dir, entry.name)], options);
    }
  } finally {
    await runOk('hdiutil', ['detach', mount, '-force'], options).catch(() => undefined);
    await rm(mount, { recursive: true, force: true });
  }
}

/** Every file below `dir`, as paths relative to `dir` with `/`, in byte order. */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort(byteCompare);
}

/** The first file below `dir` (byte order of relative path) whose name passes `test`, as an absolute path. */
export async function findFile(dir: string, test: (name: string, rel: string) => boolean): Promise<string | null> {
  for (const rel of await listFiles(dir)) {
    if (test(basename(rel), rel)) return join(dir, rel);
  }
  return null;
}

