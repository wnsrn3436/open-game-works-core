import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { exists } from '../../../lib/fsx.ts';
import { gitRaw, showFile } from '../../../lib/git.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { parseIterationRecord } from '../../loop/lib/iteration-record.ts';

/** The calibration folder of a game repo (`game-loop` `## judge calibration`). */
export const CALIBRATION_DIR = 'records/calibration';
export const LABELS_FILE = `${CALIBRATION_DIR}/labels.json`;

/** A judged pair: the `- instance:` and `- baseline:` commits of a judged loop iteration record on main. */
export interface JudgedPair {
  commit: string;
  baseline: string;
  /** The loop iteration record it comes from. */
  record: string;
}

export type Answer = 'A' | 'B' | 'same';

/** An entry of `labels.json`. */
export interface LabelEntry {
  A: string;
  B: string;
  answers: Record<string, Answer>;
  note: string;
  at: number;
}

const RECORD = /^records\/loops\/[^/]+\/iteration-(\d+)\.md$/;

/**
 * The judged pairs of main, most recent first: in the order in which the commits of the history of main (newest
 * first) added their loop iteration records.
 */
export async function judgedPairs(root: string, env: NodeJS.ProcessEnv): Promise<JudgedPair[]> {
  const log = await gitRaw(root, ['log', 'main', '--format=', '--name-only', '--diff-filter=A', '--', 'records/loops'], { env, timeoutMs: LIMITS.programMs });
  if (log.code !== 0) return [];
  const paths = [...new Set(log.stdout.split('\n').filter((line) => RECORD.test(line)))];
  const pairs: JudgedPair[] = [];
  for (const path of paths) {
    const text = await showFile(root, 'main', path, { env });
    if (text === null) continue;
    const parsed = parseIterationRecord(text.toString('utf8'), Number(RECORD.exec(path)?.[1]), path);
    if (parsed.commit !== null && parsed.baseline !== null && parsed.judges !== null) pairs.push({ commit: parsed.commit, baseline: parsed.baseline, record: path });
  }
  return pairs;
}

/** Whether the game repo has the commit. */
export async function hasCommit(root: string, commit: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return (await gitRaw(root, ['cat-file', '-e', `${commit}^{commit}`], { env })).code === 0;
}

const ANSWERS: readonly string[] = ['A', 'B', 'same'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function labelEntry(value: unknown, index: number): LabelEntry {
  const where = `${LABELS_FILE} entry ${String(index + 1)}`;
  if (!isObject(value)) throw new OgwError(`${where} is not an object`);
  const { A, B, answers, note, at } = value;
  if (typeof A !== 'string' || typeof B !== 'string' || A === '' || B === '') throw new OgwError(`${where}: A and B are not commits`);
  if (!isObject(answers) || !Object.values(answers).every((a) => typeof a === 'string' && ANSWERS.includes(a))) {
    throw new OgwError(`${where}: answers are not "A", "B" or "same" per element`);
  }
  if (typeof note !== 'string' || typeof at !== 'number') throw new OgwError(`${where}: note is not a string or at is not a number`);
  return { A, B, answers: answers as Record<string, Answer>, note, at };
}

/** The entries of a `labels.json` text; fails on a text that is not an array of entries. */
export function parseLabels(text: string): LabelEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new OgwError(`${LABELS_FILE} is not JSON`);
  }
  if (!Array.isArray(value)) throw new OgwError(`${LABELS_FILE} is not a JSON array`);
  return value.map(labelEntry);
}

/** The entries of `labels.json` in the checkout; none when it has no such file. */
export async function readLabels(root: string): Promise<LabelEntry[]> {
  const path = join(root, LABELS_FILE);
  return exists(path) ? parseLabels(await readFile(path, 'utf8')) : [];
}

/** Whether an entry has the two commits, in either order. */
export function labeled(labels: readonly LabelEntry[], pair: Pick<JudgedPair, 'commit' | 'baseline'>): boolean {
  return labels.some((l) => (l.A === pair.commit && l.B === pair.baseline) || (l.A === pair.baseline && l.B === pair.commit));
}
