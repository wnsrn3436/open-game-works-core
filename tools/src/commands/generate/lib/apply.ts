import { lstat, mkdir, readFile, readlink, rm, rmdir, symlink } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { isNotFound, writeIfChanged } from '../../../lib/fsx.ts';
import { FILE_IO, pooled } from '../../../lib/pool.ts';
import { isMetaFile, sourceOf } from '../../meta/lib/project.ts';
import { filesBelow } from './sim.ts';

/** What `ogw generate` writes, as paths relative to the checkout root. */
export interface Plan {
  files: Map<string, string | Uint8Array>;
  /** Folders made equal to a source folder: changed files written, files not in the source removed. */
  mirrors: { target: string; source: string }[];
  /** Folders whose files are copied in without removing other files. */
  overlays: { target: string; source: string }[];
  /** Relative symbolic links: `path` → `target`. */
  links: { path: string; target: string }[];
}

export interface Applied {
  written: string[];
  removed: string[];
}

export function emptyPlan(): Plan {
  return { files: new Map(), mirrors: [], overlays: [], links: [] };
}

function rel(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

/** Engine meta file whose source file is in `kept`; `ogw meta sync` owns those. */
function isKeptMeta(path: string, kept: ReadonlySet<string>): boolean {
  return isMetaFile(path) && kept.has(sourceOf(path));
}

/** Removes `dir` and its parents below `stop` while they are empty; the first folder that is not empty stops it. */
async function removeEmptyDirs(dir: string, stop: string): Promise<void> {
  for (let current = dir; current.length > stop.length; current = dirname(current)) {
    try {
      await rmdir(current);
    } catch (error) {
      // POSIX lets rmdir of a folder that is not empty fail with ENOTEMPTY or EEXIST
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return;
      throw error;
    }
  }
}

/** The files of a tree, several at a time; `applied.written` keeps the order of the files. */
async function copyTree(root: string, source: string, target: string, applied: Applied): Promise<Set<string>> {
  const files = await filesBelow(source);
  const destinations = files.map((file) => join(target, relative(source, file)));
  const changed = await pooled(files, FILE_IO, async (file, i) => writeIfChanged(destinations[i] as string, await readFile(file)));
  for (const [i, destination] of destinations.entries()) if (changed[i] === true) applied.written.push(rel(root, destination));
  return new Set(destinations);
}

async function mirror(root: string, source: string, target: string, applied: Applied): Promise<void> {
  const copied = await copyTree(root, source, target, applied);
  for (const file of await filesBelow(target)) {
    if (copied.has(file) || isKeptMeta(file, copied)) continue;
    await rm(file);
    applied.removed.push(rel(root, file));
    await removeEmptyDirs(dirname(file), target);
  }
}

async function link(root: string, path: string, target: string, applied: Applied): Promise<void> {
  const full = join(root, path);
  try {
    const info = await lstat(full);
    if (!info.isSymbolicLink()) throw new OgwError(`${path} must be a symbolic link to ${target}`);
    if ((await readlink(full)) === target) return;
    await rm(full);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await mkdir(dirname(full), { recursive: true });
  await symlink(target, full);
  applied.written.push(path);
}

/**
 * Applies a plan: only files whose bytes differ are written. The parts of the plan go in order, so that a later part
 * writes over an earlier one; the files of one part, which are distinct paths, are written several at a time.
 */
export async function applyPlan(root: string, plan: Plan): Promise<Applied> {
  const applied: Applied = { written: [], removed: [] };
  for (const { source, target } of plan.mirrors) await mirror(root, source, join(root, target), applied);
  for (const { source, target } of plan.overlays) await copyTree(root, source, join(root, target), applied);
  const files = [...plan.files];
  const changed = await pooled(files, FILE_IO, ([path, content]) => writeIfChanged(join(root, path), content));
  for (const [i, [path]] of files.entries()) if (changed[i] === true) applied.written.push(path);
  for (const { path, target } of plan.links) await link(root, path, target, applied);
  return applied;
}

