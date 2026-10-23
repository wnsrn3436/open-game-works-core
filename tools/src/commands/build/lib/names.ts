import { OgwError } from '../../../lib/errors.ts';
import { git, listTags } from '../../../lib/git.ts';

export type Env = 'DEV' | 'STG' | 'PROD';
export const ENVS: readonly Env[] = ['DEV', 'STG', 'PROD'];

/** Command arguments use upper case; names, paths, branches, tags and image tags use lower case. */
export function envLower(env: Env): string {
  return env.toLowerCase();
}

export function parseEnv(value: string): Env {
  if (value === 'DEV' || value === 'STG' || value === 'PROD') return value;
  throw new OgwError(`invalid environment: ${value} (DEV, STG or PROD)`);
}

export type Version = readonly [number, number, number];

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function parseVersion(value: string): Version | null {
  const m = VERSION.exec(value);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function requireVersion(value: string, what = 'version'): Version {
  const parsed = parseVersion(value);
  if (!parsed) throw new OgwError(`invalid ${what}: ${value} (<major>.<minor>.<patch>)`);
  return parsed;
}

/** Compares major, minor, patch in that order. */
export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function formatVersion(v: Version): string {
  return `${String(v[0])}.${String(v[1])}.${String(v[2])}`;
}

/** A build tag: `<env>-<version>` or a bundle patch tag `<env>-<app version>-bundle-<n>`. */
export interface BuildTag {
  tag: string;
  env: Env;
  /** `<major>.<minor>.<patch>`: the version, or the app version of a bundle patch. */
  version: string;
  /** Bundle patch number, or null. */
  bundle: number | null;
}

const TAG = /^(dev|stg|prod)-((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(?:-bundle-([1-9][0-9]*))?$/;

export function parseBuildTag(tag: string): BuildTag | null {
  const m = TAG.exec(tag);
  if (!m) return null;
  return {
    tag,
    env: (m[1] as string).toUpperCase() as Env,
    version: m[2] as string,
    bundle: m[3] === undefined ? null : Number(m[3]),
  };
}

export async function buildTags(cwd: string): Promise<BuildTag[]> {
  return (await listTags(cwd)).map(parseBuildTag).filter((t): t is BuildTag => t !== null);
}

/** Version string of a build: the version, or `<app version>-bundle-<n>`. */
export function buildVersionName(version: string, bundle: number | null): string {
  return bundle === null ? version : `${version}-bundle-${String(bundle)}`;
}

/** Highest version among tags that are not bundle patch tags, or null. */
export function highestVersion(tags: readonly BuildTag[], env?: Env): Version | null {
  let best: Version | null = null;
  for (const tag of tags) {
    if (tag.bundle !== null || (env !== undefined && tag.env !== env)) continue;
    const v = requireVersion(tag.version);
    if (best === null || compareVersions(v, best) > 0) best = v;
  }
  return best;
}

/** The last PROD build: the `prod-<version>` tag with the highest version (bundle patch tags not counted). */
export function lastProdTag(tags: readonly BuildTag[]): BuildTag | null {
  const best = highestVersion(tags, 'PROD');
  if (best === null) return null;
  const version = formatVersion(best);
  return tags.find((t) => t.env === 'PROD' && t.bundle === null && t.version === version) ?? null;
}

/** `lastProdTag` over tag names: the name of the last PROD build tag, or null. */
export function lastProdTagName(tags: readonly string[]): string | null {
  return lastProdTag(tags.map(parseBuildTag).filter((t): t is BuildTag => t !== null))?.tag ?? null;
}

/** Commit a tag points at. */
export async function tagCommit(cwd: string, tag: string): Promise<string> {
  return (await git(cwd, ['rev-list', '-n', '1', `refs/tags/${tag}`])).trim();
}

/**
 * Among `tags`, the one whose commit is the most recent commit of `ref`; null when none is on `ref`.
 * Returns the tag and its commit.
 */
export async function mostRecentTagOn(
  cwd: string,
  ref: string,
  tags: readonly string[],
): Promise<{ tag: string; commit: string } | null> {
  if (tags.length === 0) return null;
  const commitOf = await tagCommitsOn(cwd, ref, new Set(tags));
  const order = await newestFirst(cwd, ref, [...new Set(commitOf.values())]);
  let best: { tag: string; commit: string; index: number } | null = null;
  for (const tag of tags) {
    const commit = commitOf.get(tag);
    const index = commit === undefined ? undefined : order.get(commit);
    if (commit === undefined || index === undefined) continue;
    if (best === null || index < best.index) best = { tag, commit, index };
  }
  return best && { tag: best.tag, commit: best.commit };
}

/** The commit of each wanted tag reachable from `ref`, in one call (`*objectname` is an annotated tag's commit). */
async function tagCommitsOn(cwd: string, ref: string, wanted: ReadonlySet<string>): Promise<Map<string, string>> {
  const refs = await git(cwd, ['for-each-ref', '--merged', ref, '--format=%(refname:strip=2) %(objectname) %(*objectname)', 'refs/tags']);
  const commitOf = new Map<string, string>();
  for (const line of refs.split('\n')) {
    const [name, object, peeled] = line.split(' ');
    if (name !== undefined && object !== undefined && wanted.has(name)) commitOf.set(name, peeled || object);
  }
  return commitOf;
}

/**
 * Position of each commit of `ref` (0 newest) from the commits' common ancestor on, which comes last: only that part
 * of the history is listed.
 */
async function newestFirst(cwd: string, ref: string, commits: readonly string[]): Promise<Map<string, number>> {
  if (commits.length <= 1) return new Map(commits.map((c) => [c, 0]));
  const base = (await git(cwd, ['merge-base', '--octopus', ...commits])).trim();
  const newer = (await git(cwd, ['rev-list', ref, `^${base}`])).split('\n').filter((l) => l.length > 0);
  const order = new Map(newer.map((c, i) => [c, i]));
  order.set(base, newer.length);
  return order;
}

export function runName(env: Env, versionName: string): string {
  return `build-${envLower(env)}-${versionName}`;
}

export function buildBranch(env: Env, versionName: string): string {
  return `build/${envLower(env)}-${versionName}`;
}

/** Build tag `<env>-<version>` (AGENTS.md `## branch`); `versionName` is `<version>` or `<app version>-bundle-<n>`. */
export function buildTagName(env: Env, versionName: string): string {
  return `${envLower(env)}-${versionName}`;
}

/** `builds/<env>-<version>/` folder name: the same string as the build tag. */
export function buildDirName(env: Env, versionName: string): string {
  return buildTagName(env, versionName);
}

export type HardeningSide = 'server' | 'client';

/** Hardening record name `<env>-<version>-<server|client>-<round>.md` in `records/hardening/` (`build` `## procedure`). */
export function hardeningRecordName(env: Env, version: string, side: HardeningSide, round: number): string {
  return `${envLower(env)}-${version}-${side}-${String(round)}.md`;
}

/** Side and round of a hardening record name of that environment and version; null for any other name. */
export function parseHardeningRecordName(name: string, env: Env, version: string): { side: HardeningSide; round: number } | null {
  const prefix = `${envLower(env)}-${version}-`;
  if (!name.startsWith(prefix)) return null;
  const m = /^(server|client)-([1-9][0-9]*)\.md$/.exec(name.slice(prefix.length));
  return m ? { side: m[1] as HardeningSide, round: Number(m[2]) } : null;
}
