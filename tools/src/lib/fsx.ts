import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { OgwError } from './errors.ts';

export function exists(path: string): boolean {
  return existsSync(path);
}

/** Writes through a temporary file and a rename so that no partial file is left. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${String(process.pid)}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** JSON with 2-space indent, key order as given, and a trailing newline. */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, formatJson(value));
}

/** Writes only when the bytes differ. Returns whether the file was written. */
export async function writeIfChanged(path: string, data: string | Uint8Array): Promise<boolean> {
  const next = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  if (existsSync(path)) {
    const current = await readFile(path);
    if (current.equals(next)) return false;
  }
  await writeFileAtomic(path, next);
  return true;
}

export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) throw new OgwError(`file not found: ${path}`);
    throw error;
  }
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  const text = await readText(path);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new OgwError(`invalid JSON in ${path}: ${(error as Error).message}`);
  }
}

export async function readJsonIfExists<T = unknown>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  return readJson<T>(path);
}

export function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

/** Files below `<root>/<rel>`, as `<rel>/...` paths (`rel` `''`: paths relative to `root`); none when the folder does not exist. */
export async function filesUnder(root: string, rel: string): Promise<string[]> {
  const dir = join(root, rel);
  if (!exists(dir)) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await filesUnder(root, path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/**
 * Removes `<dir>/node_modules` when it is a symbolic link (one an earlier `ogw code check` left in a worktree points
 * into another checkout): an `npm ci` or an install check of `dir` would otherwise read or empty that checkout's
 * packages through it. Only the link is removed.
 */
export async function removeModulesLink(dir: string): Promise<void> {
  const modules = join(dir, 'node_modules');
  const stat = await lstat(modules).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (stat?.isSymbolicLink() === true) await rm(modules);
}
