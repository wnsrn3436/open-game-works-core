/**
 * The regress repo of the regression suite (ogw.md `### regress repo` of `## regress`): its states, seed manifests,
 * admissions, accepted harness and lock.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readJson, readJsonIfExists, writeJsonAtomic } from '../../../lib/fsx.ts';
import { commitPaths, gitDir } from '../../../lib/git.ts';
import { isPlainObject } from '../../../lib/json.ts';
import { withLockWithin } from '../../../lib/lock.ts';
import type { AgentSettings } from '../../../lib/settings.ts';
import { compareVersions, isVersion } from '../../core/lib/version.ts';

export interface StateEntry {
  state: string;
  game: string;
  commit: string;
  /** The game settings values the state needs and its source commit lacks, by `ogw settings set` path. */
  settings?: Record<string, unknown>;
}

export interface MatchItem {
  check: string;
  where: string;
  message: string;
}

/** `row` of a seed manifest: the fields of its defect that do not come from a check. */
export interface SeedRow {
  id: string;
  severity: 'blocker' | 'major' | 'minor';
  owner: string;
  why: string;
  source: 'check' | 'play' | 'judge';
  where?: string;
  what?: string;
  evidence?: string[];
}

export type Fixer = 'content' | 'translation' | 'none';

/** Columns of a data table that the fixer must not change: the column names that match the globs, by the row key. */
export interface FrozenColumns {
  file: string;
  columns: string[];
}

/** `seed.json` (ogw.md `### seed`). */
export interface SeedManifest {
  state: string;
  class: string;
  element: string;
  expect: 'caught' | 'missed';
  match: MatchItem[];
  performance: boolean;
  fixer: Fixer;
  row: SeedRow;
  frozen: string[];
  frozenColumns: FrozenColumns[];
  oracle: boolean;
  regenerate: boolean;
  reference: string;
}

export interface Seed {
  id: string;
  manifest: SeedManifest;
}

/** `admitted-<v>.json` (ogw.md `### admission`). */
export interface Admission {
  result: 'admitted' | 'stale';
  base: string | null;
  seeded: string | null;
  reference: string | null;
  catch: string[];
  oracle: { seeded: string; reference: string } | null;
  reason: string | null;
  at: number;
}

/** `accepted.json`: the accepted harness. */
export interface Accepted {
  commit: string;
  agents: Partial<Record<string, AgentSettings>>;
  run: string;
  at: number;
}

export const STATES_FILE = 'states.json';
export const ACCEPTED_FILE = 'accepted.json';
export const SEEDS_DIR = 'seeds';
export const LOCK_FILE = 'ogw-regress.lock';

/** The name of the game repo of regression state `state`. */
export function stateGame(state: string): string {
  return `ogw-regress-${state}`;
}

/** The name of the game repo of fix repo `n` of a run. */
export function fixGame(n: number): string {
  return `ogw-regress-fix-${String(n)}`;
}

/** The regress repo; fails, naming `ogw regress init`, when it does not exist. */
export async function regressRepo(ctx: Context): Promise<string> {
  const repo = (await ctx.workspace()).regress;
  if (!exists(join(repo, '.git'))) throw new OgwError(`no regress repo at ${repo}: run ogw regress init`);
  return repo;
}

/**
 * Runs `fn` holding the lock of the regress repo (ogw.md `## regress`): one writing `ogw regress` command at a time.
 * Fails at once when another command holds it.
 */
export async function withRegressLock<T>(ctx: Context, repo: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(await gitDir(repo, { env: ctx.env }), LOCK_FILE);
  const taken = await withLockWithin(lock, fn, 0);
  if (!taken.ran) throw new OgwError(`another ogw regress command holds ${lock}; wait for it to end`);
  return taken.value;
}

export async function commitRegress(ctx: Context, repo: string, paths: readonly string[], message: string): Promise<string | null> {
  return commitPaths(repo, paths, message, { env: ctx.env, noVerify: true });
}

export async function readStates(repo: string): Promise<StateEntry[]> {
  return (await readJsonIfExists<StateEntry[]>(join(repo, STATES_FILE))) ?? [];
}

export async function writeStates(repo: string, states: readonly StateEntry[]): Promise<void> {
  await writeJsonAtomic(join(repo, STATES_FILE), states);
}

function text(value: unknown, field: string, problems: string[]): string {
  if (typeof value === 'string' && value !== '') return value;
  problems.push(`${field} is not a non-empty string`);
  return '';
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[], problems: string[]): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  problems.push(`${field} is not one of ${allowed.join(', ')}`);
  return allowed[0] as T;
}

function bool(value: unknown, field: string, problems: string[]): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  problems.push(`${field} is not true or false`);
  return false;
}

function regex(value: unknown, field: string, problems: string[]): string {
  const source = text(value, field, problems);
  try {
    new RegExp(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    problems.push(`${field} is not a regular expression`);
  }
  return source;
}

function matchItems(value: unknown, problems: string[]): MatchItem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push('match is not an array');
    return [];
  }
  return value.map((item: unknown, i) => {
    const obj = isPlainObject(item) ? item : {};
    return { check: text(obj.check, `match.${String(i)}.check`, problems), where: regex(obj.where, `match.${String(i)}.where`, problems), message: regex(obj.message, `match.${String(i)}.message`, problems) };
  });
}

function seedRow(value: unknown, expect: string, problems: string[]): SeedRow {
  const obj = isPlainObject(value) ? value : {};
  if (!isPlainObject(value)) problems.push('row is not an object');
  const row: SeedRow = {
    id: text(obj.id, 'row.id', problems),
    severity: oneOf(obj.severity, 'row.severity', ['blocker', 'major', 'minor'] as const, problems),
    owner: text(obj.owner, 'row.owner', problems),
    why: text(obj.why, 'row.why', problems),
    source: oneOf(obj.source, 'row.source', ['check', 'play', 'judge'] as const, problems),
  };
  const given = obj.where !== undefined || obj.what !== undefined || obj.evidence !== undefined;
  if (expect === 'missed' || given) {
    row.where = text(obj.where, 'row.where', problems);
    row.what = text(obj.what, 'row.what', problems);
    row.evidence = Array.isArray(obj.evidence) && obj.evidence.every((e) => typeof e === 'string') ? obj.evidence : [];
    if (row.evidence.length === 0) problems.push('row.evidence is not a non-empty array of strings');
  }
  return row;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function frozenColumns(value: unknown, problems: string[]): FrozenColumns[] {
  if (value === undefined) return [];
  const items = Array.isArray(value) ? value : [];
  const out = items.flatMap((item: unknown) => (isPlainObject(item) && typeof item.file === 'string' && strings(item.columns) ? [{ file: item.file, columns: item.columns }] : []));
  if (!Array.isArray(value) || out.length !== items.length) problems.push('frozenColumns is not an array of {"file", "columns": [<glob>, ...]}');
  return out;
}

/** A seed manifest from its JSON, or the problems of it. */
export function parseManifest(value: unknown): { manifest: SeedManifest; problems: string[] } {
  const problems: string[] = [];
  const obj = isPlainObject(value) ? value : {};
  if (!isPlainObject(value)) problems.push('seed.json is not an object');
  const expect = oneOf(obj.expect, 'expect', ['caught', 'missed'] as const, problems);
  const match = matchItems(obj.match, problems);
  if (expect === 'caught' && match.length === 0) problems.push('match is empty for expect caught');
  const frozen = Array.isArray(obj.frozen) && obj.frozen.every((f) => typeof f === 'string') ? obj.frozen : [];
  if (obj.frozen !== undefined && frozen.length !== (obj.frozen as unknown[]).length) problems.push('frozen is not an array of strings');
  const manifest: SeedManifest = {
    state: text(obj.state, 'state', problems),
    class: text(obj.class, 'class', problems),
    element: text(obj.element, 'element', problems),
    expect,
    match,
    performance: bool(obj.performance, 'performance', problems),
    fixer: oneOf(obj.fixer, 'fixer', ['content', 'translation', 'none'] as const, problems),
    row: seedRow(obj.row, expect, problems),
    frozen,
    frozenColumns: frozenColumns(obj.frozenColumns, problems),
    oracle: bool(obj.oracle, 'oracle', problems),
    regenerate: bool(obj.regenerate, 'regenerate', problems),
    reference: typeof obj.reference === 'string' ? obj.reference : '',
  };
  return { manifest, problems };
}

/** The folder of seed `id`. */
export function seedDir(repo: string, id: string): string {
  return join(repo, SEEDS_DIR, id);
}

/** Every seed of the regress repo in id order; a seed whose manifest has problems fails the read. */
export async function listSeeds(repo: string): Promise<Seed[]> {
  const dir = join(repo, SEEDS_DIR);
  if (!exists(dir)) return [];
  const ids = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const seeds: Seed[] = [];
  for (const id of ids) seeds.push({ id, manifest: await readManifest(join(dir, id)) });
  return seeds;
}

export async function readManifest(folder: string): Promise<SeedManifest> {
  const { manifest, problems } = parseManifest(await readJson(join(folder, 'seed.json')));
  if (problems.length > 0) throw new OgwError(`${join(folder, 'seed.json')}: ${problems.join('; ')}`);
  return manifest;
}

export function admissionPath(repo: string, id: string, version: string): string {
  return join(seedDir(repo, id), `admitted-${version}.json`);
}

export async function readAdmission(repo: string, id: string, version: string): Promise<Admission | null> {
  return readJsonIfExists<Admission>(admissionPath(repo, id, version));
}

/** The `patch-<u>.diff` (or `reference-<u>.diff`) of the seed with the highest `<u>` not above `version`, or null. */
export async function latestPatch(repo: string, id: string, version: string, kind: 'patch' | 'reference'): Promise<{ version: string; path: string } | null> {
  const dir = seedDir(repo, id);
  if (!exists(dir)) return null;
  const pattern = new RegExp(`^${kind}-(.+)\\.diff$`);
  const versions = (await readdir(dir))
    .map((name) => pattern.exec(name)?.[1] ?? '')
    .filter((v) => isVersion(v) && compareVersions(v, version) <= 0)
    .sort(compareVersions);
  const best = versions.at(-1);
  return best === undefined ? null : { version: best, path: join(dir, `${kind}-${best}.diff`) };
}

export async function readAccepted(repo: string): Promise<Accepted | null> {
  return readJsonIfExists<Accepted>(join(repo, ACCEPTED_FILE));
}
