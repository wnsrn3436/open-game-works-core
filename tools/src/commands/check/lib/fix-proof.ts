/**
 * The fix test proof of `ogw check --loop` (ogw.md `### fix test proof` of `## check`): the regression tests that the
 * content agent report names for a `fixed` defect, from the test files the iteration added or changed, run on the
 * code before the iteration (the fix base) and must fail there.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { ignoreCleanupError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { git, worktreeAdd, worktreeRemove } from '../../../lib/git.ts';
import { newId } from '../../../lib/ids.ts';
import { LIMITS } from '../../../lib/limits.ts';
import type { RunState } from '../../../lib/runstate.ts';
import { runServerTests } from '../../core/lib/server-tests.ts';
import { binaryBuild } from '../../data/lib/binary-build.ts';
import { generateCheckout } from '../../generate/api.ts';
import { proofExemption, type Defect, type DefectsFile, type ReportRow } from '../../loop/lib/defects.ts';
import type { FixTestProof, ProofTest } from '../../loop/lib/files.ts';
import { reportRows } from '../../loop/lib/record.ts';
import { readGameText, readRunJson, runRel } from '../../loop/lib/run.ts';
import { importClient } from './engine.ts';
import { clientGutRun, regressionDb, regressionInputs, type ClientRunOptions } from './regression.ts';

const TEST_DIRS = ['client/tests', 'server/tests'] as const;

export type ProofOptions = Pick<ClientRunOptions, 'godot' | 'runTimeLimitMs' | 'startTimeLimitMs' | 'db'>;

/** The result of each test that a run of one test file reports, by test name; `started` when the test runner started. */
interface FileRun {
  started: boolean;
  /** Why the run did not start the test runner, or why it ended; null for a run that reported. */
  why: string | null;
  results: Map<string, string>;
}

interface Changed {
  path: string;
  deleted: boolean;
}

/** `<test file>::<test>` with the test file relative to the game repo (`client/` in place of `res://`). */
function normalName(name: string): string {
  return name.startsWith('res://') ? `client/${name.slice('res://'.length)}` : name;
}

function fileOf(name: string): string {
  return normalName(name).split('::')[0] as string;
}

/** The commit that added `content-input-<n>.md` in the history of `commit`: the fix base; null without one. */
async function fixBase(ctx: Context, game: GameRepo, run: RunState, commit: string): Promise<string | null> {
  const out = await git(game.root, ['log', '--diff-filter=A', '--format=%H', commit, '--', runRel(run, `content-input-${String(run.iteration)}.md`)], { env: ctx.env });
  return out.split('\n').filter((line) => line !== '').at(-1) ?? null;
}

/** The files under `client/tests/` and `server/tests/` that differ between the two commits. */
async function changedTests(ctx: Context, game: GameRepo, from: string, to: string): Promise<Changed[]> {
  const out = await git(game.root, ['diff', '--name-status', '-z', '--no-renames', from, to, '--', ...TEST_DIRS], { env: ctx.env });
  const parts = out.split('\0').filter((part) => part !== '');
  const changed: Changed[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) changed.push({ path: parts[i + 1] as string, deleted: parts[i] === 'D' });
  return changed;
}

/** A proof that runs no test. */
function noRun(id: string, result: FixTestProof['result'], reason: string): FixTestProof {
  return { id, result, reason, tests: [] };
}

/** The proof of a row from the results of its tests on the fix base. */
function proofOf(id: string, tests: ProofTest[], base: string): FixTestProof {
  if (tests.length === 0) return noRun(id, 'fail', 'no named test in a test file that the commits of the iteration added or changed');
  if (tests.some((t) => t.result === 'fail')) return { id, result: 'pass', reason: null, tests };
  const unknown = tests.filter((t) => t.result === 'unknown');
  if (unknown.length > 0) return { id, result: 'unknown', reason: unknown.map((t) => `${t.name}: ${t.reason ?? 'not run'}`).join('; '), tests };
  return { id, result: 'fail', reason: `the named tests pass on ${base.slice(0, 12)}, the code before the fix`, tests };
}

/** The result of a named test from the run of its file (ogw.md `### fix test proof`). */
function testOf(name: string, run: FileRun): ProofTest {
  const status = run.results.get(normalName(name));
  if (status === 'fail') return { name, result: 'fail', reason: null };
  if (status === 'pass') return { name, result: 'pass', reason: null };
  if (status !== undefined) return { name, result: 'unknown', reason: `the run reports it ${status}` };
  if (run.started) return { name, result: 'fail', reason: `the run does not report it${run.why === null ? '' : `: ${run.why}`}` };
  return { name, result: 'unknown', reason: run.why ?? 'the test runner did not start' };
}

interface ClientResultFile {
  results?: { name?: unknown; status?: unknown }[];
}

/** A client test file run alone, as `ogw check --regression <file>` runs it. */
async function clientFile(ctx: Context, root: string, file: string, options: ProofOptions): Promise<FileRun> {
  const ran = await clientGutRun(ctx, root, file, options);
  const results = new Map<string, string>();
  for (const test of (ran.json as ClientResultFile | null)?.results ?? []) results.set(normalName(String(test.name)), String(test.status));
  const why = ran.ran.stopped === true ? 'the test runner did not start' : ran.ran.timedOut ? 'the run reached its time limit' : ran.json === null ? `the run sent no result (exit code ${String(ran.ran.code ?? ran.ran.signal)})` : null;
  return { started: ran.started, why, results };
}

/** A server test file run alone, as `ogw check --regression <file>` runs it. */
async function serverFile(ctx: Context, root: string, file: string, options: ProofOptions): Promise<FileRun> {
  const db = await regressionDb(ctx, options.db);
  try {
    const run = await runServerTests({ checkout: root, target: file, kind: 'regression', inputs: regressionInputs(root, db?.url ?? null), env: ctx.env, timeoutMs: LIMITS.programMs });
    const results = new Map((run.result?.results ?? []).map((t) => [t.name, t.status]));
    const why = run.timedOut ? 'the run reached its time limit' : run.result === null ? `vitest wrote no report (exit code ${String(run.exitCode)})` : null;
    return { started: run.result !== null || run.timedOut, why, results };
  } finally {
    await db?.close();
  }
}

/**
 * Runs each test file of `files` alone in a worktree of the fix base with the changed test files of `commit` laid over
 * it, its generated files written and its client imported. A run that cannot set up the worktree reports why for every
 * file.
 */
async function runOnBase(ctx: Context, game: GameRepo, base: string, commit: string, changed: readonly Changed[], files: readonly string[], options: ProofOptions): Promise<Map<string, FileRun>> {
  const worktree = join((await ctx.workspace()).worktrees, game.name, `proof-${newId()}`);
  const runs = new Map<string, FileRun>();
  const none = (why: string): Map<string, FileRun> => new Map(files.map((f) => [f, { started: false, why, results: new Map() }]));
  try {
    await worktreeAdd(game.mainRoot, worktree, base, undefined, { env: ctx.env });
    const kept = changed.filter((c) => !c.deleted).map((c) => c.path);
    if (kept.length > 0) await git(worktree, ['checkout', commit, '--', ...kept], { env: ctx.env });
    for (const c of changed.filter((d) => d.deleted)) await rm(join(worktree, c.path), { force: true });
    const checkout: GameRepo = { ...game, root: worktree, inWorktree: true };
    try {
      await generateCheckout(ctx, checkout);
      await binaryBuild(ctx, checkout, 'the generated files of the fix base could not be written');
    } catch (error) {
      return none((error as Error).message.split('\n')[0] as string);
    }
    const client = files.filter((f) => f.startsWith('client/'));
    const importFailure = client.length > 0 ? await importClient(ctx, options.godot, worktree) : null;
    for (const file of files) {
      if (file.startsWith('client/') && importFailure !== null) runs.set(file, { started: false, why: `the client import failed: ${importFailure}`, results: new Map() });
      else runs.set(file, file.startsWith('client/') ? await clientFile(ctx, worktree, file, options) : await serverFile(ctx, worktree, file, options));
    }
    return runs;
  } catch (error) {
    return none(`the worktree of the fix base could not be made: ${(error as Error).message.split('\n')[0] as string}`);
  } finally {
    // the proof is decided; a worktree left behind (or one that was never made) changes no result
    await worktreeRemove(game.mainRoot, worktree, { env: ctx.env }).catch(ignoreCleanupError);
  }
}

/** A `fixed` row that needs the proof, with the named tests that count. */
interface Needed {
  id: string;
  tests: string[];
}

/**
 * The fix test proof of each `fixed` row of the content agent report of the iteration, in report order (ogw.md
 * `### fix test proof` of `## check`). It does not throw: what could not be run is `unknown` with the reason.
 */
export async function fixTestProofs(ctx: Context, game: GameRepo, run: RunState, commit: string, options: ProofOptions): Promise<FixTestProof[]> {
  const text = await readGameText(game, runRel(run, `content-${String(run.iteration)}.md`));
  if (text === null) return [];
  const fixed = [...reportRows(text)].filter(([, row]) => row.result === 'fixed');
  if (fixed.length === 0) return [];
  const defects = new Map(((await readRunJson<DefectsFile>(game, run, 'defects.json'))?.defects ?? []).map((d) => [d.id, d]));
  try {
    return await proofsOf(ctx, game, run, commit, fixed, defects, options);
  } catch (error) {
    // e.g. git cannot read the history: no row that needs the proof has a result
    const why = (error as Error).message.split('\n')[0] as string;
    return fixed.map(([id, row]) => exempt(id, row, defects.get(id)) ?? noRun(id, 'unknown', why));
  }
}

/** The proof of a row that needs none: `unknown` with why; null for a row that needs one. */
function exempt(id: string, row: ReportRow, defect: Defect | undefined): FixTestProof | null {
  if (defect === undefined) return noRun(id, 'unknown', 'not a defect of defects.json');
  const why = proofExemption(defect, row.note);
  return why === null ? null : noRun(id, 'unknown', why);
}

async function proofsOf(
  ctx: Context,
  game: GameRepo,
  run: RunState,
  commit: string,
  fixed: readonly [string, ReportRow][],
  defects: ReadonlyMap<string, Defect>,
  options: ProofOptions,
): Promise<FixTestProof[]> {
  const needed: Needed[] = [];
  for (const [id, row] of fixed) if (exempt(id, row, defects.get(id)) === null) needed.push({ id, tests: row.tests ?? [] });
  const base = needed.length === 0 ? null : await fixBase(ctx, game, run, commit);
  const changed = base === null ? [] : await changedTests(ctx, game, base, commit);
  const counted = new Set(changed.filter((c) => !c.deleted).map((c) => c.path));
  for (const n of needed) n.tests = n.tests.filter((name) => counted.has(fileOf(name)));
  const files = [...new Set(needed.flatMap((n) => n.tests.map(fileOf)))];
  const runs = base === null || files.length === 0 ? new Map<string, FileRun>() : await runOnBase(ctx, game, base, commit, changed, files, options);
  return fixed.map(([id, row]) => {
    const done = exempt(id, row, defects.get(id));
    if (done !== null) return done;
    if (base === null) return noRun(id, 'unknown', `no commit added ${runRel(run, `content-input-${String(run.iteration)}.md`)}`);
    const tests = (needed.find((n) => n.id === id)?.tests ?? []).map((name) => testOf(name, runs.get(fileOf(name)) as FileRun));
    return proofOf(id, tests, base);
  });
}
