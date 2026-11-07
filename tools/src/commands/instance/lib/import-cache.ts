import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, utimes } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { readJsonIfExists, whenNotFound, writeJsonAtomic } from '../../../lib/fsx.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { withLock, withLockWithin } from '../../../lib/lock.ts';
import { isAlive } from '../../../lib/proc.ts';
import { span } from '../../../lib/spans.ts';

/**
 * The import cache of `--commit` checkouts (ogw.md `## runner`): the engine import of a checkout, kept under the SHA-256
 * of every file the import reads, so that the next checkout with the same files gets a copy of it in place of the import.
 */

/** The folder of the entries in the git common dir of the game repo. */
export const IMPORT_CACHE = 'ogw-import-cache';

/** The folders of a checkout whose files the engine import reads: the Godot project and the resources it links. */
const READ = ['client', 'resource'];

/** The import folder of the Godot project, which the import makes and the entry holds whole. */
const IMPORTED = join('client', '.godot');

/** The manifest of an entry: the files outside `client/.godot/` the import added or changed, and those it removed. */
interface Entry {
  products: string[];
  removed: string[];
}

/** What a file under `READ` is before the import: its content (or link target) for the key, its size and time for the products. */
interface InputFile {
  /** `file <SHA-256>` or `link <target>`. */
  content: string;
  size: number;
  mtimeMs: number;
}

/**
 * Copies with an APFS clone where the volume has one, else as a plain copy; times as the source has them, and a
 * symbolic link with its target text as it is, never made to point into the checkout it was copied from.
 */
const COPY = { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE } as const;

/** A file up to this size is read whole for its hash; a larger one is streamed. */
const READ_WHOLE_BYTES = 8 * 1024 * 1024;

/** How many files are hashed at once: the hashes of a checkout's many small files wait on the disk, not on each other. */
const HASHES_AT_ONCE = 32;

async function sha256(path: string, size: number): Promise<string> {
  if (size <= READ_WHOLE_BYTES) return createHash('sha256').update(await readFile(path)).digest('hex');
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Runs `work` on every item, `HASHES_AT_ONCE` at a time. */
async function eachAtOnce<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) await work(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(HASHES_AT_ONCE, items.length) }, lane));
}

/** Whether `path` is `root` or below it. */
function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/** A file whose content the key takes: the path the content is read from, for the path the file has in the checkout. */
interface Hashed {
  name: string;
  path: string;
  size: number;
  prefix: string;
}

/** The walk of the files of a checkout (`inputFiles`). */
interface Walk {
  /** The checkout and the folders under `READ` there, as real paths: a link to a path in them adds nothing. */
  real: string;
  readRoots: (string | null)[];
  withContent: boolean;
  files: Map<string, InputFile>;
  hashed: Hashed[];
}

/**
 * A symbolic link: a file of its target text. One to a folder outside the folders the import reads in the checkout has
 * the files of that folder below it; one to such a file stands for that file's content too.
 */
async function walkLink(walk: Walk, path: string, name: string): Promise<void> {
  const info = await lstat(path);
  const link = `link ${await readlink(path)}`;
  walk.files.set(name, { content: link, size: 0, mtimeMs: info.mtimeMs });
  const target = await realpath(path).catch(whenNotFound(null));
  if (target === null || (inside(walk.real, target) && walk.readRoots.some((r) => r !== null && inside(r, target)))) return;
  const targetInfo = await stat(target);
  if (targetInfo.isDirectory()) await walkDir(walk, target, name);
  else if (walk.withContent) walk.hashed.push({ name, path: target, size: targetInfo.size, prefix: `${link} file ` });
}

async function walkDir(walk: Walk, dir: string, rel: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(whenNotFound([]));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const name = join(rel, entry.name);
    if (name === IMPORTED) continue;
    if (entry.isSymbolicLink()) await walkLink(walk, path, name);
    else if (entry.isDirectory()) await walkDir(walk, path, name);
    else if (entry.isFile()) {
      const info = await lstat(path);
      walk.files.set(name, { content: 'file', size: info.size, mtimeMs: info.mtimeMs });
      if (walk.withContent) walk.hashed.push({ name, path, size: info.size, prefix: 'file ' });
    }
  }
}

/**
 * Every file under `READ` of the checkout but `client/.godot/`, by path relative to the checkout, with its content
 * hashed when `withContent` (`walkLink` for a symbolic link), so that the key covers every file the import reads.
 */
async function inputFiles(root: string, withContent: boolean): Promise<Map<string, InputFile>> {
  const readRoots = await Promise.all(READ.map((name) => realpath(join(root, name)).catch(whenNotFound(null))));
  const walk: Walk = { real: await realpath(root), readRoots, withContent, files: new Map(), hashed: [] };
  for (const name of READ) await walkDir(walk, join(root, name), name);
  await eachAtOnce(walk.hashed, async (h) => {
    (walk.files.get(h.name) as InputFile).content = `${h.prefix}${await sha256(h.path, h.size)}`;
  });
  return walk.files;
}

/** The key of the import of the checkout with these files by the engine at `engine`: the SHA-256 of both. */
function keyOf(files: ReadonlyMap<string, InputFile>, engine: string): string {
  const hash = createHash('sha256').update(`ogw import cache 1\0${engine}\0`);
  for (const path of [...files.keys()].sort()) hash.update(`${path}\0${(files.get(path) as InputFile).content}\n`);
  return hash.digest('hex');
}

/**
 * Copies the entry `key` into the checkout: `client/.godot/` and the files the import added or changed, and removes the
 * files it removed. False without the entry. A copy that fails removes the entry and what it copied of `client/.godot/`,
 * so that no instance starts on a part of an import, and fails.
 */
async function takeEntry(dir: string, key: string, root: string): Promise<boolean> {
  const entry = join(dir, key);
  const manifest = await readJsonIfExists<Entry>(join(entry, 'entry.json'));
  if (manifest === null) return false;
  try {
    await cp(join(entry, 'files', IMPORTED), join(root, IMPORTED), COPY);
    for (const path of manifest.products) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await cp(join(entry, 'files', path), join(root, path), COPY);
    }
    for (const path of manifest.removed) await rm(join(root, path), { force: true });
  } catch (error) {
    await rm(join(root, IMPORTED), { recursive: true, force: true });
    await rm(entry, { recursive: true, force: true });
    throw error;
  }
  // the time of its last use, by which the cache removes its oldest entries
  const now = new Date();
  await utimes(join(entry, 'entry.json'), now, now);
  return true;
}

/** Keeps the import of the checkout as the entry `key`: `client/.godot/` and the files outside it that the import added, changed or removed. */
async function keepEntry(dir: string, key: string, root: string, before: ReadonlyMap<string, InputFile>): Promise<void> {
  const after = await inputFiles(root, false);
  const products = [...after].filter(([path, file]) => {
    const was = before.get(path);
    return was === undefined || was.size !== file.size || was.mtimeMs !== file.mtimeMs || was.content.startsWith('link') !== file.content.startsWith('link');
  }).map(([path]) => path);
  const removed = [...before.keys()].filter((path) => !after.has(path));
  const tmp = join(dir, `${key}.tmp-${String(process.pid)}-${randomBytes(4).toString('hex')}`);
  try {
    await mkdir(join(tmp, 'files'), { recursive: true });
    await cp(join(root, IMPORTED), join(tmp, 'files', IMPORTED), COPY);
    for (const path of products) {
      await mkdir(dirname(join(tmp, 'files', path)), { recursive: true });
      await cp(join(root, path), join(tmp, 'files', path), COPY);
    }
    await writeJsonAtomic(join(tmp, 'entry.json'), { products, removed } satisfies Entry);
    await rm(join(dir, key), { recursive: true, force: true });
    await rename(tmp, join(dir, key));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Removes the entries beyond the `keep` used last, but `current` and an entry whose lock another start holds, and the
 * folders a store of a process that is gone left.
 */
async function removeOld(dir: string, keep: number, current: string): Promise<void> {
  const names = await readdir(dir);
  for (const name of names) {
    const pid = /^[0-9a-f]{64}\.tmp-(\d+)-[0-9a-f]+$/.exec(name)?.[1];
    if (pid !== undefined && !isAlive(Number(pid))) await rm(join(dir, name), { recursive: true, force: true });
  }
  const entries: { key: string; usedMs: number }[] = [];
  for (const name of names.filter((n) => /^[0-9a-f]{64}$/.test(n))) {
    const used = await stat(join(dir, name, 'entry.json')).catch(whenNotFound(null));
    if (used !== null) entries.push({ key: name, usedMs: used.mtimeMs });
  }
  const old = entries.filter((e) => e.key !== current).sort((a, b) => b.usedMs - a.usedMs).slice(Math.max(0, keep - 1));
  for (const { key } of old) await withLockWithin(join(dir, `${key}.lock`), () => rm(join(dir, key), { recursive: true, force: true }), 0);
}

export interface ImportCache {
  /** The git common dir of the game repo, which holds the cache. */
  commonDir: string;
  /** The entries the cache keeps: those used last. */
  keep: number;
}

/**
 * The engine import of a fresh checkout through the cache: a copy of the entry of its key, or else `importer`, whose
 * import is kept as the entry. The starts of one key take its lock, so one imports and the others copy its entry.
 * Returns whether the import ran.
 */
export async function importThroughCache(cache: ImportCache, root: string, engine: string, importer: () => Promise<boolean>): Promise<boolean> {
  const dir = join(cache.commonDir, IMPORT_CACHE);
  await mkdir(dir, { recursive: true });
  const { before, key } = await span('import key', async () => {
    const files = await inputFiles(root, true);
    return { before: files, key: keyOf(files, engine) };
  });
  // an import of a large game takes long: the lock waits as long as a job does
  return withLock(
    join(dir, `${key}.lock`),
    async () => {
      if (await span('import copy', () => takeEntry(dir, key, root))) return false;
      const ran = await span('import run', importer);
      if (!ran) return false;
      await span('import keep', async () => {
        await keepEntry(dir, key, root, before);
        await removeOld(dir, cache.keep, key);
      });
      return true;
    },
    LIMITS.jobMs,
  );
}

/** The key of the import of the checkout `root` by the engine at `engine`. */
export async function importKey(root: string, engine: string): Promise<string> {
  return keyOf(await inputFiles(root, true), engine);
}
