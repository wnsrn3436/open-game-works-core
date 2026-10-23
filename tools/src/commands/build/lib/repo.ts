import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exists } from '../../../lib/fsx.ts';
import { gitRaw, showFile } from '../../../lib/git.ts';

/** Reads game repo files from the working tree or from a commit. Paths are game-repo relative with `/`. */
export interface RepoReader {
  read(path: string): Promise<string | null>;
  /** Files below a folder, game-repo relative. */
  list(folder: string): Promise<string[]>;
}

export function workingTree(root: string): RepoReader {
  return {
    async read(path) {
      const full = join(root, path);
      return exists(full) ? readFile(full, 'utf8') : null;
    },
    async list(folder) {
      const base = folder.replace(/\/$/, '');
      const full = join(root, base);
      if (!exists(full)) return [];
      const entries = await readdir(full, { recursive: true, withFileTypes: true });
      return entries
        .filter((e) => e.isFile())
        .map((e) => `${base}/${join(e.parentPath, e.name).slice(full.length + 1).split('\\').join('/')}`)
        .sort();
    },
  };
}

export function atCommit(root: string, ref: string): RepoReader {
  return {
    async read(path) {
      return (await showFile(root, ref, path))?.toString('utf8') ?? null;
    },
    async list(folder) {
      const result = await gitRaw(root, ['ls-tree', '-r', '--name-only', ref, '--', folder]);
      if (result.code !== 0) return [];
      return result.stdout.split('\n').filter((l) => l.length > 0);
    },
  };
}
