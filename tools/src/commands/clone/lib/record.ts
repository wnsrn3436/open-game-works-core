import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readText, writeFileAtomic } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { withLock } from '../../../lib/lock.ts';
import { openRun } from '../../../lib/runstate.ts';

const HEADING = '## reproduction';

/** `records/loops/<run>/request.md` of the open loop run. Fails when the game has no open loop run. */
export async function loopRequestFile(repo: GameRepo): Promise<string> {
  const run = await openRun(repo);
  if (run?.kind !== 'loop') throw new OgwError(`no open loop run for game ${repo.name}`);
  const path = join(repo.root, 'records', 'loops', run.name, 'request.md');
  if (!exists(path)) throw new OgwError(`${path} does not exist`);
  return path;
}

function isSectionEnd(line: string): boolean {
  return line.startsWith('# ') || line.startsWith('## ');
}

/** The text with `line` added at the end of its `## reproduction` section; the section is made at the end when missing. */
export function withReproductionLine(text: string, line: string): string {
  const lines = text.split('\n');
  const start = lines.indexOf(HEADING);
  if (start === -1) {
    const body = text.replace(/\n*$/, '');
    return `${body === '' ? '' : `${body}\n\n`}${HEADING}\n\n${line}\n`;
  }
  let end = start + 1;
  while (end < lines.length && !isSectionEnd(lines[end] as string)) end++;
  let lastContent = start;
  for (let i = start + 1; i < end; i++) if ((lines[i] as string).trim() !== '') lastContent = i;
  const at = lastContent + 1;
  const insert = lastContent === start ? ['', line] : [line];
  if (at === end && end < lines.length) insert.push('');
  lines.splice(at, 0, ...insert);
  const joined = lines.join('\n');
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}

/**
 * Adds `line` at the end of `## reproduction` in the request file of the game repo. The file is not committed.
 * The read and the write hold the file lock `ogw-reproduction.lock` in the git common dir, so `ogw clone` commands
 * that run at the same time do not drop each other's line.
 */
export async function addReproductionLine(repo: GameRepo, path: string, line: string): Promise<void> {
  await withLock(join(repo.commonDir, 'ogw-reproduction.lock'), async () => {
    await writeFileAtomic(path, withReproductionLine(await readText(path), line));
  });
}
