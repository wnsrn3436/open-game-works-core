import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { readJsonIfExists, writeJsonAtomic } from '../../../lib/fsx.ts';
import { isPlainObject } from '../../../lib/json.ts';

/** The regression mark (ogw.md `### regression state` of `## regress`): `ogw-regress.json` in the git dir of the repo. */
export const MARK_FILE = 'ogw-regress.json';

export interface RegressionMark {
  kind: 'state' | 'fix';
  state: string;
}

/** The regression mark in the git dir `commonDir`, or null when the repo has none. */
export async function readMark(commonDir: string): Promise<RegressionMark | null> {
  const value = await readJsonIfExists(join(commonDir, MARK_FILE));
  if (!isPlainObject(value) || (value.kind !== 'state' && value.kind !== 'fix') || typeof value.state !== 'string') return null;
  return { kind: value.kind, state: value.state };
}

export async function writeMark(commonDir: string, mark: RegressionMark): Promise<void> {
  await writeJsonAtomic(join(commonDir, MARK_FILE), mark);
}

/** Fails for a game with the regression mark: `what` does not run in a regression state or a fix repo. */
export async function refuseMarked(game: { name: string; commonDir: string }, what: string): Promise<void> {
  const mark = await readMark(game.commonDir);
  if (mark !== null) {
    const kind = mark.kind === 'state' ? 'regression state' : 'fix repo';
    throw new OgwError(`${what} does not run in ${game.name}: it is a ${kind} of the regression suite (ogw regress)`);
  }
}
