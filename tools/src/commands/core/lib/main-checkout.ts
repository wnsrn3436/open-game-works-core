/**
 * The main checkout of `open-game-works-core-impl/`: core agent merges and generated file commits change it one at a time
 * (ogw.md `## agent merge`, `core` command.md `## core spec file`).
 */
import { resolve } from 'node:path';
import { checkoutLock, currentBranch, git, isCheckout, statusLines } from '../../../lib/git.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { addReader, withWriter, withWriterLock, type RwLock } from '../../../lib/rwlock.ts';

/** The lock of the main checkout. A merge waits for the module tests of every core test run on it: the wait of a job. */
async function mainLock(coreImpl: string, env: NodeJS.ProcessEnv): Promise<RwLock> {
  return { base: await checkoutLock(coreImpl, 'ogw-core-main.lock', { env }), waitMs: LIMITS.jobMs };
}

/**
 * Runs `fn` holding the lock of the main checkout `coreImpl`. With `readers`, it first waits, holding the lock, until no
 * core test run tests the checkout: a merge then never changes the code under module tests, and core test runs that
 * start meanwhile wait for the merge.
 */
export async function withCoreMain<T>(coreImpl: string, env: NodeJS.ProcessEnv, fn: () => Promise<T>, options: { readers?: boolean } = {}): Promise<T> {
  const lock = await mainLock(coreImpl, env);
  return options.readers === true ? withWriter(lock, fn) : withWriterLock(lock, fn);
}

/**
 * Whether a checkout path is a generated file: `core-spec/`, or a committed generation target of the core test data
 * build (`data` SKILL.md `## data tool` and tool.md: `server/` as is, the engine project `client/<engine>/` for `client/`),
 * and the core test data files its matching run changes.
 */
export function isGeneratedPath(path: string): boolean {
  return path.startsWith('core-spec/') || path.startsWith('test-data/data/') || /^server\/(dev\/)?generated\//.test(path) || /^client\/[^/]+\/(dev\/)?generated\//.test(path) || /^client\/[^/]+\/project\.godot$/.test(path);
}

/** Generated files whose working tree differs from HEAD: changed, deleted or untracked (both paths of a rename). */
async function changedGenerated(dir: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const fields = (await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { env })).split('\0');
  const paths = new Set<string>();
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] as string;
    if (field.length < 4) continue;
    paths.add(field.slice(3));
    // a rename or copy entry is followed by its source path
    if (field[0] === 'R' || field[0] === 'C') paths.add(fields[(i += 1)] ?? '');
  }
  return [...paths].filter(isGeneratedPath).sort();
}

/**
 * Commits every generated file that differs from HEAD, and nothing else. A core test data file that already had a change
 * when the run started (`before`) is not the run's: it stays uncommitted. Returns whether it made a commit.
 */
export async function commitGenerated(dir: string, env: NodeJS.ProcessEnv, before: ReadonlySet<string> = new Set()): Promise<boolean> {
  const paths = (await changedGenerated(dir, env)).filter((path) => !(path.startsWith('test-data/data/') && before.has(path)));
  if (paths.length === 0) return false;
  await git(dir, ['add', '--all', '--', ...paths], { env });
  await git(dir, ['commit', '--quiet', '--no-verify', '-m', 'ogw: regenerate generated files', '--', ...paths], { env });
  return true;
}

/**
 * Runs `fn`, which writes generated files in `implDir`, and then `after` with its value. When `implDir` is the main
 * checkout `coreImpl`, both run holding the lock, so merges never see the files uncommitted, and on branch main the
 * generated files are committed between them. The commit is made also when `fn` fails: the files it wrote come from
 * committed spec and tools.
 */
async function generating<T, U>(implDir: string, coreImpl: string, env: NodeJS.ProcessEnv, fn: () => Promise<T>, after: (value: T, main: boolean) => Promise<U>): Promise<U> {
  if (resolve(implDir) !== resolve(coreImpl) || !isCheckout(coreImpl)) return after(await fn(), false);
  return withCoreMain(coreImpl, env, async () => {
    const before = new Set(await changedGenerated(implDir, env));
    let value: T;
    try {
      value = await fn();
    } finally {
      if ((await currentBranch(implDir, { env })) === 'main') await commitGenerated(implDir, env, before);
    }
    return after(value, true);
  });
}

/** Runs `fn`, which writes generated files in `implDir`, and commits them on main of the main checkout (`generating`). */
export async function withGeneratedCommit<T>(implDir: string, coreImpl: string, env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  return generating(implDir, coreImpl, env, fn, (value) => Promise.resolve(value));
}

/** What `testAtHead` returns: the commit the module tests run on, and the end of the run's hold on the checkout. */
export interface TestStart {
  head: string;
  /** Whether the checkout had no change after the generated commit: a run of a dirty checkout records nothing. */
  clean: boolean;
  /** Called when the module tests end: a merge waiting for them may then go on. */
  release: () => Promise<void>;
}

/**
 * Before the module tests of a core test run: `fn` (the preflight) as `withGeneratedCommit`, then HEAD read before a
 * merge waiting for the lock can move it. On the main checkout the run then holds it as a reader until `release`.
 */
export async function testAtHead(implDir: string, coreImpl: string, env: NodeJS.ProcessEnv, fn: () => Promise<void>): Promise<TestStart> {
  return generating(implDir, coreImpl, env, fn, async (_value, main) => ({
    head: (await git(implDir, ['rev-parse', 'HEAD'], { env })).trim(),
    // read while the writer is held, after the generated commit: no other run or merge changes the checkout meanwhile
    clean: (await statusLines(implDir, { env })).length === 0,
    release: main ? await addReader(await mainLock(coreImpl, env)) : () => Promise.resolve(),
  }));
}
