import { join } from 'node:path';
import { readJsonIfExists, writeJsonAtomic } from '../../../lib/fsx.ts';
import { commonDir, git, showFile } from '../../../lib/git.ts';
import { withLock } from '../../../lib/lock.ts';
import { outcomeOf, SCREEN_LOCKED, type Outcome, type Result } from '../../../lib/outcome.ts';

export type ModuleResult = Result;

/** One `ogw core test` run recorded on a clean checkout. */
export interface TestRecord {
  commit: string;
  /** `server`, `<engine>`, `<engine> --web` or `tools`. */
  target: string;
  /** The result of each module; read with `recordOutcome`, which also reads the `skipped` of a part left out. */
  modules: Record<string, ModuleResult | 'skipped'>;
  /** The reason of each `unknown` module. */
  reasons?: Record<string, string>;
  /** The reason of each `skipped` module. */
  skips?: Record<string, string>;
  /** The commit of the render pass `pass` each module took for its render pass not run (ogw.md `### Godot core test`). */
  inherited?: Record<string, string>;
  recordedAt: number;
}

/** The reason a `skipped` of a render pass not run on a locked macOS screen holds. */
const SKIPPED_SCREEN_LOCKED = 'render pass not run: the macOS screen is locked or the display sleeps';

/** The outcome of `module` in `record` (`outcomeOf`); a module the record does not hold is `unknown`, not recorded. */
export function recordOutcome(record: TestRecord, module: string): Outcome {
  const skip = record.skips?.[module];
  return outcomeOf(record.modules[module], record.reasons?.[module] ?? (skip === SKIPPED_SCREEN_LOCKED ? SCREEN_LOCKED : (skip ?? null)));
}

interface RecordFile {
  records: TestRecord[];
}

async function recordPaths(implDir: string): Promise<{ file: string; lock: string }> {
  const dir = await commonDir(implDir);
  return { file: join(dir, 'ogw-core-tests.json'), lock: join(dir, 'ogw-core-tests.lock') };
}

/** Adds a record to the git common dir of `open-game-works-core-impl/`. */
export async function addTestRecord(implDir: string, record: TestRecord): Promise<void> {
  const paths = await recordPaths(implDir);
  await withLock(paths.lock, async () => {
    const file = (await readJsonIfExists<RecordFile>(paths.file)) ?? { records: [] };
    file.records.push(record);
    await writeJsonAtomic(paths.file, file);
  });
}

export async function readTestRecords(implDir: string): Promise<TestRecord[]> {
  const paths = await recordPaths(implDir);
  return (await readJsonIfExists<RecordFile>(paths.file))?.records ?? [];
}

/** Per target, the latest result of each module over all records of `commit` (`mergedRecords`). */
export async function mergedResults(implDir: string, commit: string): Promise<Map<string, Map<string, ModuleResult>>> {
  return new Map([...(await mergedRecords(implDir, commit))].map(([target, modules]) => [target, new Map([...modules].map(([m, o]) => [m, o.result]))]));
}

/**
 * Per target, the latest outcome of each module over all records of `commit` (ogw.md `## core release`): that of its last
 * record, except that an `unknown` does not replace an earlier `pass` or `fail`, which a run of the whole module gave.
 */
export async function mergedRecords(implDir: string, commit: string): Promise<Map<string, Map<string, Outcome>>> {
  const merged = new Map<string, Map<string, Outcome>>();
  const records = (await readTestRecords(implDir))
    .filter((record) => record.commit === commit)
    .sort((a, b) => a.recordedAt - b.recordedAt);
  for (const record of records) {
    const target = merged.get(record.target) ?? new Map<string, Outcome>();
    for (const module of Object.keys(record.modules)) {
      const outcome = recordOutcome(record, module);
      const earlier = target.get(module);
      if (outcome.result === 'unknown' && earlier !== undefined && earlier.result !== 'unknown') continue;
      target.set(module, outcome);
    }
    merged.set(record.target, target);
  }
  return merged;
}

/** The `side` of a `core-spec/` file's bytes, or null. */
export function sideOf(bytes: Buffer | null): unknown {
  try {
    return bytes === null ? null : (JSON.parse(bytes.toString('utf8')) as { side?: unknown }).side;
  } catch {
    // a core-spec file that is not JSON names no client module
    return null;
  }
}

/** Module name and side of every `core-spec/` file at `commit` (main by default). */
/** Sides of `core-spec/` per commit hash: a commit's files do not change. */
const sidesByCommit = new Map<string, Promise<[string, unknown][]>>();

async function coreSpecSides(repo: string, commit = 'main'): Promise<[string, unknown][]> {
  if (commit !== 'main') {
    const key = `${repo}\0${commit}`;
    let cached = sidesByCommit.get(key);
    if (cached === undefined) {
      cached = readCoreSpecSides(repo, commit);
      sidesByCommit.set(key, cached);
    }
    return cached;
  }
  return readCoreSpecSides(repo, commit);
}

async function readCoreSpecSides(repo: string, commit: string): Promise<[string, unknown][]> {
  const listed = (await git(repo, ['ls-tree', '--name-only', commit, 'core-spec/'])).split('\n').filter((path) => path.endsWith('.json'));
  const sides: [string, unknown][] = [];
  for (const path of listed) sides.push([path.slice('core-spec/'.length, -'.json'.length), sideOf(await showFile(repo, commit, path))]);
  return sides;
}

/**
 * Whether, going through the core test records of target `engine` in record order, the latest result of every client
 * module in `core-spec/` at that record's commit has been `pass` at some point (a run of some modules records those
 * alone; a module added later does not undo it). Until then the client core of that engine has never compiled as a
 * whole: a client module or tool job merges without a passing core test (ogw.md `## agent merge`), and `ogw core
 * test tools` leaves out that engine's round trip (`core` command.md). A later failure does not undo it.
 */
/** The engines of `client/<engine>/engine.json` on main whose client core passed (`clientCorePassed`). */
export async function passedEngines(repo: string, engines: readonly string[]): Promise<Set<string>> {
  const passed = new Set<string>();
  for (const engine of engines) if (await clientCorePassed(repo, engine)) passed.add(engine);
  return passed;
}

export async function clientCorePassed(repo: string, engine: string): Promise<boolean> {
  // a core test on main: a record of a commit that main holds, not one of an agent branch that was not merged
  const mainCommits = new Set((await git(repo, ['rev-list', 'main'])).split('\n').filter((line) => line !== ''));
  const records = (await readTestRecords(repo))
    .filter((record) => record.target === engine && mainCommits.has(record.commit))
    .sort((a, b) => a.recordedAt - b.recordedAt);
  const clients = new Map<string, string[]>();
  const latest = new Map<string, Outcome>();
  // a client core that compiles: `pass`, or `unknown` only because a locked screen left out a render pass after its headless pass passed
  const compiles = (name: string): boolean => {
    const outcome = latest.get(name);
    return outcome !== undefined && (outcome.result === 'pass' || (outcome.result === 'unknown' && outcome.reason === SCREEN_LOCKED));
  };
  for (const record of records) {
    for (const name of Object.keys(record.modules)) latest.set(name, recordOutcome(record, name));
    let client = clients.get(record.commit);
    if (client === undefined) {
      client = (await coreSpecSides(repo, record.commit)).filter(([, side]) => side === 'client').map(([name]) => name);
      clients.set(record.commit, client);
    }
    if (client.length > 0 && client.every(compiles)) return true;
  }
  return false;
}
