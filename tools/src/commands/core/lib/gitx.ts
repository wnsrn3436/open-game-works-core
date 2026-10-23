import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git, showFile } from '../../../lib/git.ts';

/** Paths (relative to the checkout root) that `git status` shows as changed, including untracked files. */
export async function changedPaths(root: string): Promise<Set<string>> {
  const out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const fields = out.split('\0');
  const paths = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string;
    if (field.length < 4) continue;
    paths.add(field.slice(3));
    if (field[0] === 'R' || field[0] === 'C') {
      const from = fields[i + 1];
      if (from) paths.add(from);
      i++;
    }
  }
  return paths;
}

/** Writes the files below `relDir` at revision `rev` into `dest` (keeping their relative paths). */
export async function exportTree(root: string, rev: string, relDir: string, dest: string): Promise<number> {
  const out = await git(root, ['ls-tree', '-r', '-z', '--name-only', rev, '--', relDir]);
  const files = out.split('\0').filter((line) => line.length > 0);
  for (const file of files) {
    const bytes = await showFile(root, rev, file);
    if (!bytes) continue;
    const target = join(dest, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  return files.length;
}
