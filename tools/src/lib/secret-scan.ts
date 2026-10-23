import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** A value the build-time check `secret` looks for. */
export interface Needle {
  /** What the failure names; never the value. */
  label: string;
  value: Buffer;
}

/** 1-based lines on which `value` starts in `bytes`, each line once, searching the whole buffer. */
function hitLines(bytes: Buffer, value: Buffer): number[] {
  const lines: number[] = [];
  let line = 1;
  let counted = 0;
  for (let at = bytes.indexOf(value); at !== -1; at = bytes.indexOf(value, at + Math.max(1, value.length))) {
    for (let i = bytes.indexOf(0x0a, counted); i !== -1 && i < at; i = bytes.indexOf(0x0a, i + 1)) line++;
    counted = at;
    if (lines.at(-1) !== line) lines.push(line);
  }
  return lines;
}

/**
 * Failures for the needles in one file's bytes. Each needle is searched in the whole buffer, so a value with line
 * breaks is found in either mode. With `lines`, a text file gives `<where>:<line>: <label>` for each line a hit starts
 * on; otherwise, and for a binary file (one holding a NUL byte), `<where>: <label>`.
 */
export function needleHits(where: string, bytes: Buffer, needles: readonly Needle[], lines: boolean): string[] {
  if (!lines || bytes.includes(0)) return needles.filter((n) => bytes.includes(n.value)).map((n) => `${where}: ${n.label}`);
  return needles.flatMap((needle) => hitLines(bytes, needle.value).map((line) => `${where}:${String(line)}: ${needle.label}`));
}

/** Build-time check `secret` on files below `root`: every regular file, whatever its size, is searched. */
export async function scanFiles(root: string, files: readonly string[], needles: readonly Needle[], options: { lines: boolean }): Promise<string[]> {
  const failures: string[] = [];
  for (const file of files) {
    const path = join(root, file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    failures.push(...needleHits(file, await readFile(path), needles, options.lines));
  }
  return failures;
}
