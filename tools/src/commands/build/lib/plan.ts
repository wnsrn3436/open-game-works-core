import { OgwError } from '../../../lib/errors.ts';
import { revParse, showFile, tagExists } from '../../../lib/git.ts';
import { sectionText } from './markdown.ts';
import {
  buildTagName,
  buildVersionName,
  compareVersions,
  formatVersion,
  highestVersion,
  lastProdTag,
  mostRecentTagOn,
  requireVersion,
  runName,
  type BuildTag,
  type Env,
} from './names.ts';

export interface BuildPlan {
  /** `<version>` or `<app version>-bundle-<n>`. */
  version: string;
  bundle: number | null;
  /** The main commit the build branch is made from. */
  startCommit: string;
}

export interface PlanInput {
  root: string;
  env: Env;
  version: string | undefined;
  bundleFor: string | undefined;
  tags: BuildTag[];
}

function nextBundle(tags: readonly BuildTag[], env: Env, appVersion: string): number {
  const used = tags.filter((t) => t.env === env && t.version === appVersion && t.bundle !== null).map((t) => t.bundle as number);
  return used.length === 0 ? 1 : Math.max(...used) + 1;
}

async function requireAppTag(root: string, env: Env, appVersion: string): Promise<void> {
  requireVersion(appVersion, '--bundle-for app version');
  const tag = buildTagName(env, appVersion);
  if (!(await tagExists(root, tag))) throw new OgwError(`tag ${tag} of the app version does not exist`);
}

async function mainHead(root: string): Promise<string> {
  const commit = await revParse(root, 'main');
  if (commit === null) throw new OgwError('branch main does not exist');
  return commit;
}

/** DEV, STG: the version (`build` `## procedure` 1) and main HEAD. */
export async function planDevStg(input: PlanInput): Promise<BuildPlan> {
  const { root, env, tags } = input;
  const startCommit = await mainHead(root);
  if (input.bundleFor !== undefined) {
    await requireAppTag(root, env, input.bundleFor);
    const bundle = nextBundle(tags, env, input.bundleFor);
    return { version: buildVersionName(input.bundleFor, bundle), bundle, startCommit };
  }
  const highest = highestVersion(tags);
  if (input.version !== undefined) {
    const wanted = requireVersion(input.version, '--version');
    if (highest !== null && compareVersions(wanted, highest) <= 0) {
      throw new OgwError(`--version ${input.version} is not higher than the highest tag version ${formatVersion(highest)}`);
    }
    return { version: formatVersion(wanted), bundle: null, startCommit };
  }
  const version = highest === null ? '0.1.0' : formatVersion([highest[0], highest[1], highest[2] + 1]);
  return { version, bundle: null, startCommit };
}

async function prodSource(input: PlanInput): Promise<{ tag: string; commit: string; bundle: number | null; version: string }> {
  const { root, tags } = input;
  let candidates: BuildTag[];
  if (input.bundleFor !== undefined) {
    await requireAppTag(root, 'PROD', input.bundleFor);
    candidates = tags.filter((t) => t.env === 'STG' && t.version === input.bundleFor && t.bundle !== null);
  } else if (input.version !== undefined) {
    const version = formatVersion(requireVersion(input.version, '--version'));
    candidates = tags.filter((t) => t.env === 'STG' && t.bundle === null && t.version === version);
  } else {
    candidates = tags.filter((t) => t.env === 'STG' && t.bundle === null);
  }
  const found = await mostRecentTagOn(root, 'main', candidates.map((t) => t.tag));
  if (!found) throw new OgwError('no main commit has the stg tag to build PROD from');
  const tag = candidates.find((t) => t.tag === found.tag) as BuildTag;
  return { tag: found.tag, commit: found.commit, bundle: tag.bundle, version: tag.version };
}

/** PROD: the `stg-<version>` commit of main to build from (`build` `## procedure` 1). */
export async function planProd(input: PlanInput): Promise<BuildPlan & { compatibilityBase: string }> {
  const source = await prodSource(input);
  const version = buildVersionName(source.version, source.bundle);
  if (await tagExists(input.root, `prod-${version}`)) throw new OgwError(`tag prod-${version} already exists`);
  const last = lastProdTag(input.tags);
  if (source.bundle === null && last !== null && compareVersions(requireVersion(source.version), requireVersion(last.version)) <= 0) {
    throw new OgwError(`version ${source.version} is not higher than the last PROD build ${last.version}`);
  }
  const base = last?.tag ?? 'none';
  const endPath = `records/loops/${runName('STG', version)}/end.md`;
  const end = await showFile(input.root, 'main', endPath);
  if (end === null) throw new OgwError(`${endPath} is not on main: a new STG build is needed`);
  const recorded = sectionText(end.toString('utf8'), 'compatibility base');
  if (recorded !== base) {
    throw new OgwError(`${endPath} compatibility base ${recorded} is not the last PROD build ${base}: a new STG build is needed`);
  }
  return { version, bundle: source.bundle, startCommit: source.commit, compatibilityBase: base };
}
