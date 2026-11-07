/**
 * The seed agent of `ogw regress refresh` (ogw.md `### seed agent` of `## regress`): a seed that a changed base made
 * stale, rebased by the seed agent onto that base, and admitted again with the files it wrote.
 */
import { lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { exists, readJsonIfExists, writeFileAtomic } from '../../../lib/fsx.ts';
import { git } from '../../../lib/git.ts';
import { section } from '../../../lib/markdown.ts';
import { claudeTempName } from '../../agent/lib/cli-command.ts';
import { newAgentFolder } from '../../agent/lib/files.ts';
import { SEED_RESULTS } from '../../agent/lib/result-format.ts';
import { document } from '../../loop/lib/markdown.ts';
import type { RefreshRun } from './refresh.ts';
import { latestPatch, seedDir, stateGame, type Admission, type Seed } from './repo.ts';
import { runSeedAgent } from './seed-agent.ts';

export type RebaseOutcome = 'rebased' | 'not admitted' | 'not rebased' | 'refused' | 'failed';

/** What the seed agent of a seed came to: the `rebase` cell of the record. */
export interface SeedRebase {
  job: string | null;
  outcome: RebaseOutcome;
  /** The reason of the admission of the rebase (`not admitted`), the paths it may not change (`refused`), or why the job failed. */
  reason: string | null;
}

/** Whether a stale admission goes to the seed agent: `patch does not apply` and `oracle`, not `not <expect>` or `base fails target`. */
export function rebasable(admission: Admission): boolean {
  return admission.result === 'stale' && /^(?:patch does not apply|oracle)(?::|$)/.test(admission.reason ?? '');
}

/** The `rebase` cell of `## seeds` of the refresh record: `none`, or `<outcome> (<job>)` with `: <reason>` when it has one. */
export function rebaseText(rebase: SeedRebase | null | undefined): string {
  if (rebase === null || rebase === undefined) return 'none';
  return `${rebase.outcome} (${rebase.job ?? 'no job'})${rebase.reason === null ? '' : `: ${rebase.reason}`}`;
}

/** The files the refresh writes in a seed folder, which the copy for the seed agent leaves out. */
function toolRecord(rel: string): boolean {
  return /^(?:admitted-.+\.json|rebase-.+\.md)$/.test(rel);
}

/** The result file of the seed agent of `<v>` kept in the seed folder, for the human (`### regress repo`). */
export function rebaseRecordName(version: string): string {
  return `rebase-${version}.md`;
}

/** The files under `root`, relative and in `/` form, with the entries that are neither a file nor a folder. */
async function filesUnder(root: string, keep: (rel: string) => boolean): Promise<{ files: string[]; odd: string[] }> {
  const files: string[] = [];
  const odd: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (!keep(path)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
      else odd.push(path);
    }
  };
  await walk('');
  return { files: files.sort(), odd: odd.sort() };
}

/** A file the seed agent wrote that the refresh takes into the seed folder. */
interface TakenFile {
  rel: string;
  bytes: Buffer;
}

/**
 * The files the seed agent may write (`### seed agent` 3): `patch-<v>.diff`, and for a seed with `oracle` also
 * `reference-<v>.diff` and the probe file that `oracle/oracle.json` names; the first two of them are required.
 */
async function writable(original: string, seed: Seed, version: string): Promise<{ allowed: string[]; required: string[] }> {
  const required = [`patch-${version}.diff`, ...(seed.manifest.oracle ? [`reference-${version}.diff`] : [])];
  const probe = seed.manifest.oracle ? (await readJsonIfExists<{ probe?: unknown }>(join(original, 'oracle', 'oracle.json')))?.probe : undefined;
  return { allowed: [...required, ...(typeof probe === 'string' && probe !== '' ? [`oracle/${probe}`] : [])], required };
}

/**
 * The files of a result of `rebased` (`### seed agent` 3): those the copy `copy` changed against the seed folder, or why
 * the result is refused: a path it may not change, a required file it lacks, or an entry that is not a regular file.
 */
async function takeFiles(original: string, seed: Seed, version: string, copy: string): Promise<{ files: TakenFile[] } | { refused: string }> {
  const keep = (rel: string): boolean => !toolRecord(rel);
  const before = await filesUnder(original, keep);
  const after = await filesUnder(copy, keep);
  if (after.odd.length > 0) return { refused: `not a regular file: ${after.odd.join(', ')}` };
  const { allowed, required } = await writable(original, seed, version);
  const missing = required.filter((rel) => !after.files.includes(rel));
  if (missing.length > 0) return { refused: `it wrote no ${missing.join(', ')}` };
  const changed: string[] = [];
  for (const rel of [...new Set([...before.files, ...after.files])].sort()) {
    if (!before.files.includes(rel) || !after.files.includes(rel)) changed.push(rel);
    else if (!(await readFile(join(original, rel))).equals(await readFile(join(copy, rel)))) changed.push(rel);
  }
  const outside = changed.filter((rel) => !allowed.includes(rel));
  if (outside.length > 0) return { refused: `it changed ${outside.join(', ')}, which it may not change` };
  const files: TakenFile[] = [];
  for (const rel of changed) files.push({ rel, bytes: await readFile(join(copy, rel)) });
  return { files };
}

/** Writes `files` into `folder`; the returned function puts back what was there. */
async function putFiles(folder: string, files: readonly TakenFile[]): Promise<() => Promise<void>> {
  const previous: { path: string; bytes: Buffer | null }[] = [];
  for (const file of files) {
    const path = join(folder, file.rel);
    previous.push({ path, bytes: exists(path) ? await readFile(path) : null });
    await writeFileAtomic(path, file.bytes);
  }
  return async () => {
    for (const { path, bytes } of previous) {
      if (bytes === null) await rm(path, { force: true });
      else await writeFileAtomic(path, bytes);
    }
  };
}

/**
 * `base/` of the folder (`### seed agent` 1): a new repo whose branch `base` is the tag `tag` of the state fetched with
 * its history and no other ref, so that no branch of another seed is in it, with no remote and a git identity of its own.
 */
async function cloneBase(ctx: Context, stateRoot: string, tag: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const env = { env: ctx.env };
  await git(dir, ['init', '--quiet'], env);
  await git(dir, ['fetch', '--quiet', '--no-tags', stateRoot, `refs/tags/${tag}`], env);
  await git(dir, ['checkout', '--quiet', '-b', 'base', 'FETCH_HEAD'], env);
  await rm(join(dir, '.git', 'FETCH_HEAD'), { force: true });
  for (const [key, value] of [
    ['user.name', 'seed agent'],
    ['user.email', 'seed-agent@localhost'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', '/dev/null'],
  ] as const) {
    await git(dir, ['config', key, value], env);
  }
}

/** What the refresh gives the rebase of one seed. */
export interface RebaseContext {
  run: RefreshRun;
  /** The tag of the base of the state of the seed. */
  tag: string;
  /** Admits the seed at the version on the base of its state again (`### admission`), with the files in its folder. */
  admit: () => Promise<Admission>;
}

/** The folder of the seed agent made ready (`### seed agent` 1): the copy of the seed, the clone of the base and the input. */
async function prepareFolder(ctx: Context, rc: RebaseContext, seed: Seed, before: Admission, folder: string): Promise<string> {
  const original = seedDir(rc.run.repo, seed.id);
  const copy = join(folder, 'seed');
  const { files } = await filesUnder(original, (rel) => !toolRecord(rel));
  for (const rel of files) await writeFileAtomic(join(copy, rel), await readFile(join(original, rel)));
  await cloneBase(ctx, (await ctx.game(stateGame(seed.manifest.state))).mainRoot, rc.tag, join(folder, 'base'));
  const { repo, version } = rc.run;
  const patch = await latestPatch(repo, seed.id, version, 'patch');
  const reference = seed.manifest.oracle ? await latestPatch(repo, seed.id, version, 'reference') : null;
  const release = join((await ctx.workspace()).coreReleases, version);
  const name = (found: { path: string } | null): string => (found === null ? 'none' : `\`${basename(found.path)}\``);
  const input = join(folder, 'input.md');
  await writeFileAtomic(
    input,
    document([
      ['seed', seed.id],
      ['core version', version],
      ['stale reason', before.reason ?? ''],
      ['old patch', name(patch)],
      ['old reference', name(reference)],
      ['core release', exists(release) ? release : 'none'],
    ]),
  );
  return input;
}

/** What the seed agent left, read before its folder is removed. */
type AgentWork =
  | { kind: 'failed'; job: string | null; reason: string }
  | { kind: 'not rebased'; job: string; text: string }
  | { kind: 'refused'; job: string; text: string; reason: string }
  | { kind: 'rebased'; job: string; text: string; files: TakenFile[] };

/** The first line of `## result` of a result file, which `ogw agent` checked (`### result format`). */
function resultOf(text: string): (typeof SEED_RESULTS)[number] | null {
  const line = (section(text, 'result') ?? []).map((l) => l.trim()).find((l) => l !== '');
  return SEED_RESULTS.find((r) => r === line) ?? null;
}

/**
 * Makes the folder, runs the seed agent in it and takes what it left (`### seed agent` 1 to 3), then removes the folder
 * and the folder of Claude Code for it under its temp root (5).
 */
async function runInFolder(ctx: Context, rc: RebaseContext, seed: Seed, before: Admission): Promise<AgentWork> {
  const folder = await newAgentFolder('seed', ctx.env);
  try {
    let input: string;
    try {
      input = await prepareFolder(ctx, rc, seed, before, folder);
    } catch (error) {
      return { kind: 'failed', job: null, reason: `its folder could not be made: ${error instanceof Error ? error.message : String(error)}` };
    }
    const ran = await runSeedAgent(ctx, folder, input);
    if (ran.status !== 'done' || ran.output === null || ran.job === null) return { kind: 'failed', job: ran.job, reason: ran.reason ?? 'no result file' };
    if (!(await lstat(ran.output)).isFile()) return { kind: 'failed', job: ran.job, reason: 'the result file is not a regular file' };
    const text = await readFile(ran.output, 'utf8');
    if (resultOf(text) !== 'rebased') return { kind: 'not rebased', job: ran.job, text };
    const taken = await takeFiles(seedDir(rc.run.repo, seed.id), seed, rc.run.version, join(folder, 'seed'));
    return 'refused' in taken ? { kind: 'refused', job: ran.job, text, reason: taken.refused } : { kind: 'rebased', job: ran.job, text, files: taken.files };
  } finally {
    await rm(folder, { recursive: true, force: true });
    const uid = process.getuid?.();
    if (uid !== undefined) await rm(join('/tmp', `claude-${String(uid)}`, claudeTempName(folder)), { recursive: true, force: true });
  }
}

/**
 * Rebases one seed whose admission `before` is stale for a reason that goes to the seed agent (`### seed agent`): the
 * seed agent, as one piece of work of the refresh (`regress.parallel`), then the files it wrote put into the seed folder
 * and admitted; when admission does not admit them, they are put back and `before` stays. No other work writes the seed
 * folder or the branches of the seed, so this takes no lock. It holds no performance lease: it starts no instance and
 * runs no `ogw`.
 */
export async function rebaseSeed(ctx: Context, rc: RebaseContext, seed: Seed, before: Admission): Promise<{ admission: Admission; rebase: SeedRebase }> {
  const kept = (rebase: SeedRebase): { admission: Admission; rebase: SeedRebase } => ({ admission: before, rebase });
  const work = await rc.run.pool.work(() => runInFolder(ctx, rc, seed, before));
  if (work.kind === 'failed') return kept({ job: work.job, outcome: 'failed', reason: work.reason });
  const folder = seedDir(rc.run.repo, seed.id);
  await writeFileAtomic(join(folder, rebaseRecordName(rc.run.version)), work.text);
  if (work.kind === 'not rebased') return kept({ job: work.job, outcome: 'not rebased', reason: null });
  if (work.kind === 'refused') return kept({ job: work.job, outcome: 'refused', reason: work.reason });
  const restore = await putFiles(folder, work.files);
  const admission = await rc.admit();
  if (admission.result === 'admitted') return { admission, rebase: { job: work.job, outcome: 'rebased', reason: null } };
  await restore();
  return kept({ job: work.job, outcome: 'not admitted', reason: admission.reason });
}
