// The harness markdown files that `ogw docs check` reads.
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../../../lib/git.ts';
import { mdLines, type MdLine } from '../../core/lib/spec-md.ts';

export interface DocFile {
  /** Path relative to the harness root, with `/`. */
  rel: string;
  abs: string;
  lines: MdLine[];
}

export interface Failure {
  item: string;
  /** `<file>:<line>`, `<file>`, or empty. */
  where: string;
  reason: string;
}

export function at(file: string, n?: number): string {
  return n === undefined ? file : `${file}:${String(n)}`;
}

/** Files that are not harness documents: the introductions for humans (`AGENTS.md` `## repo`) and `CLAUDE.md`, which only imports `AGENTS.md`. */
const NOT_HARNESS_DOCS = new Set(['README.md', 'README.ko.md', 'CLAUDE.md']);

/**
 * Markdown files of the harness working tree: tracked files and untracked files that git does not
 * ignore. Symbolic links (`.claude/skills`, `.agents/skills`), the `CLAUDE.md` import of `AGENTS.md` and the human
 * introductions `README.md` and `README.ko.md` are not read.
 */
export async function listDocs(harness: string): Promise<DocFile[]> {
  const out = await git(harness, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const paths = [...new Set(out.split('\0').filter((p) => p.endsWith('.md') && !NOT_HARNESS_DOCS.has(p)))].sort();
  const docs: DocFile[] = [];
  for (const rel of paths) {
    const abs = join(harness, rel);
    const stat = await lstat(abs).catch(() => null);
    if (!stat?.isFile()) continue;
    docs.push({ rel, abs, lines: mdLines(await readFile(abs, 'utf8')) });
  }
  return docs;
}

/** `AGENTS.md` and the `.md` files of `agents/`, `skills/`, `tools/`. */
export function isHarnessDoc(rel: string): boolean {
  return rel === 'AGENTS.md' || /^(agents|skills|tools)\//.test(rel);
}
