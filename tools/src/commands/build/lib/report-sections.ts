import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exists } from '../../../lib/fsx.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { git, gitRaw, showFile } from '../../../lib/git.ts';
import { jobLogPaths, listJobs, type JobRecord } from '../../../lib/jobs.ts';
import { jobsOfRun, type RunState } from '../../../lib/runstate.ts';
import type { BuildRunResult } from './buildrun.ts';
import { FAILED_STEP } from '../../deploy/api.ts';
import { needsHumanLines } from '../../loop/lib/api.ts';
import { bullets, contentItems, sectionLines, stripBullet } from './markdown.ts';
import { buildDirName, parseHardeningRecordName, type Env } from './names.ts';
import type { ProdOrders } from './prodorder.ts';

/** Where a build may go (`build` `## platform build`, external beta rule). */
export function outlets(env: Env, platform: string): string {
  if (env === 'STG' && platform === 'android') return 'Google Play open testing and closed testing';
  if (env === 'STG' && platform === 'ios') return 'TestFlight public link';
  // macos is signed with Developer ID and distributed directly, not through the Mac App Store
  if (env === 'STG' && platform === 'macos') return 'direct download for testers';
  if (env === 'PROD' && (platform === 'android' || platform === 'ios')) return 'store review, internal testing, release';
  if (env === 'PROD' && platform === 'macos') return 'direct distribution: Steam, itch.io, web download';
  return 'none';
}

export function artifactsBody(env: Env, result: BuildRunResult | null): string {
  if (!result) return 'none';
  return bullets(result.artifacts.map((a) => `${a.platform}: ${a.path} (${outlets(env, a.platform)})${a.freeSigning === undefined ? '' : ` free signing: ${a.freeSigning}`}`));
}

export function serverImageBody(result: BuildRunResult | null): string {
  const image = result?.serverImage;
  if (!image) return 'none';
  return bullets([`name: ${image.name}`, `image tag: ${image.tag}`, `digest: ${image.digest}`]);
}

export function protocolChangeBody(result: BuildRunResult | null): string {
  const change = result?.protocolChange;
  if (!change) return 'none';
  return bullets([
    `client_data_version: ${change.client_data_version}`,
    `compat_client_data_version: ${change.compat_client_data_version}`,
  ]);
}

export function convertersBody(result: BuildRunResult | null): string {
  const converters = result?.converters;
  if (!converters) return 'none';
  return bullets(converters.map((c) => `(${c.kind}, ${String(c.fromVersion)})`));
}

export const CORE_SCHEMA_SENTENCE = 'After this build is deployed, the PROD server cannot be rolled back to the last PROD build.';

export function coreSchemaBody(result: BuildRunResult | null): string {
  const schema = result?.coreSchema;
  if (!schema) return 'none';
  const lines = [`- last PROD build: ${String(schema.last ?? 'none')}`, `- this build: ${String(schema.current ?? 'none')}`];
  if (coreSchemaChanged(result)) lines.push('', CORE_SCHEMA_SENTENCE);
  return lines.join('\n');
}

/** The two `coreSchemaVersion` differ; false without a last PROD build, which has nothing to go back to. */
function coreSchemaChanged(result: BuildRunResult | null): boolean {
  const schema = result?.coreSchema;
  return schema != null && schema.last !== null && schema.last !== schema.current;
}

/** Files of a ref below a folder. */
async function filesAt(game: GameRepo, ref: string, folder: string): Promise<string[]> {
  const result = await gitRaw(game.root, ['ls-tree', '-r', '--name-only', ref, '--', folder]);
  if (result.code !== 0) return [];
  return result.stdout.split('\n').filter((line) => line.length > 0);
}

export async function hardeningBody(game: GameRepo, branch: string, env: Env, version: string): Promise<string> {
  const records: { path: string; side: string; round: number }[] = [];
  for (const path of await filesAt(game, branch, 'records/hardening/')) {
    const parsed = parseHardeningRecordName(path.slice('records/hardening/'.length), env, version);
    if (parsed) records.push({ path, ...parsed });
  }
  if (records.length === 0) return 'none';
  records.sort((a, b) => a.side.localeCompare(b.side) || a.round - b.round);
  const lines = [bullets(records.map((r) => r.path))];
  for (const side of ['server', 'client']) {
    const last = records.filter((r) => r.side === side).at(-1);
    if (!last) continue;
    const text = (await showFile(game.root, branch, last.path))?.toString('utf8') ?? '';
    const unknown = contentItems(sectionLines(text, 'unknown'));
    lines.push('', `${side} round ${String(last.round)} unknown:`, bullets(unknown.map(stripBullet)));
  }
  return lines.join('\n');
}

interface LoopCheck {
  name: string;
  platform: string | null;
  result: string;
}

/**
 * `check-<iteration>.json` of the step 4 iteration: the highest iteration of the run on the branch that also has
 * `evaluate-<iteration>.json` (a fix iteration runs `ogw check --loop` without `ogw loop evaluate`); null when none.
 */
async function lastCheckFile(game: GameRepo, branch: string, run: string): Promise<{ path: string; checks: LoopCheck[] } | null> {
  const files = await filesAt(game, branch, `records/loops/${run}/`);
  const evaluated = new Set(files.flatMap((path) => /\/evaluate-([1-9][0-9]*)\.json$/.exec(path)?.[1] ?? []));
  let best: { path: string; n: number } | null = null;
  for (const path of files) {
    const m = /\/check-([1-9][0-9]*)\.json$/.exec(path);
    if (m && evaluated.has(m[1] as string) && (best === null || Number(m[1]) > best.n)) best = { path, n: Number(m[1]) };
  }
  if (!best) return null;
  const text = (await showFile(game.root, branch, best.path))?.toString('utf8') ?? '{}';
  const parsed = JSON.parse(text) as { checks?: LoopCheck[] };
  return { path: best.path, checks: parsed.checks ?? [] };
}

export async function checksBody(game: GameRepo, branch: string, run: string, result: BuildRunResult | null): Promise<string> {
  const lines: string[] = [];
  for (const check of result?.checks ?? []) lines.push(`- ${check.name}: ${check.result}`);
  if (result && result.webSmokeLoadingMs !== null) lines.push(`- web smoke first loading ms: ${String(result.webSmokeLoadingMs)}`);
  const checkFile = await lastCheckFile(game, branch, run);
  for (const check of checkFile?.checks ?? []) {
    if (check.name !== 'performance' && check.name !== 'UI quality') continue;
    const where = check.platform === null ? '' : ` (${check.platform})`;
    lines.push(`- ${check.name}${where}: ${check.result} (${checkFile?.path ?? ''})`);
  }
  return lines.length === 0 ? 'none' : lines.join('\n');
}

export async function privacyBody(game: GameRepo, env: Env, version: string, prodServerUrl: string | null): Promise<string> {
  const rel = `builds/${buildDirName(env, version)}/privacy`;
  const dir = join(game.root, rel);
  const files = exists(dir) ? (await readdir(dir)).sort().map((name) => `${rel}/${name}`) : [];
  const lines = files.map((file) => `- ${file}`);
  if (env === 'PROD' && prodServerUrl !== null) lines.push(`- account deletion URL: ${prodServerUrl}/account/deletion`);
  return lines.length === 0 ? 'none' : lines.join('\n');
}

async function jobOutput(job: JobRecord, env: NodeJS.ProcessEnv): Promise<string> {
  const paths = await jobLogPaths(job, env);
  const read = async (path: string): Promise<string> => (exists(path) ? readFile(path, 'utf8') : '');
  return `${await read(paths.stdout)}\n${await read(paths.stderr)}`;
}

/** DEV, STG: result and failed step of the last `ogw deploy` job of the run. */
export async function deployJobBody(game: GameRepo, run: RunState, env: NodeJS.ProcessEnv): Promise<string> {
  const jobs = jobsOfRun(run, await listJobs(env), game.name).filter((job) => job.command === 'deploy');
  const last = jobs.at(-1);
  if (!last) return 'none';
  const output = await jobOutput(last, env);
  const failed = output.split('\n').find((line) => line.startsWith(FAILED_STEP));
  const result = last.status === 'running' ? 'running' : last.exitCode === 0 ? 'done' : 'failed';
  return bullets([`job: ${last.id}`, `result: ${result}`, `failed step: ${failed?.slice(FAILED_STEP.length) ?? 'none'}`]);
}

export interface ProdDeployFacts {
  version: string;
  result: BuildRunResult | null;
  /** True for a bundle patch without data (no server image). */
  noServerImage: boolean;
  updateFiles: string[];
  /** `builds/prod-<version>/update/update.json` exists. */
  updateJson: boolean;
  previousServerImage: string;
}

function annotate(step: string, notes: string[]): string {
  return notes.length === 0 ? step : `${step}\n${notes.map((note) => `   - ${note}`).join('\n')}`;
}

function stepData(index: number, facts: ProdDeployFacts): string[] {
  const r = facts.result;
  switch (index) {
    case 1:
      return [`artifacts: ${r?.artifacts.map((a) => a.path).join(', ') || 'none'}`];
    case 2:
      return [`update files: ${facts.updateFiles.join(', ') || 'none'}`];
    case 3:
      return [`match wait ms: ${String(r?.matchWaitMs ?? 'none')}`];
    case 4:
      return [`server image: ${r?.serverImage ? `${r.serverImage.name}@${r.serverImage.digest}` : 'none'}`];
    default:
      return [];
  }
}

function needsMaintenance(r: BuildRunResult | null): boolean {
  return (r?.converters?.length ?? 0) > 0 || coreSchemaChanged(r);
}

function deployNotes(index: number, facts: ProdDeployFacts): string[] {
  const notes: string[] = [];
  if (facts.noServerImage && index >= 3 && index <= 5) notes.push('skipped: bundle patch without server image');
  notes.push(...stepData(index, facts));
  if ((index === 4 || index === 8) && facts.result?.protocolChange == null) {
    notes.push('skipped part: protocol change (not a protocol change build)');
  }
  if ((index === 4 || index === 5) && !needsMaintenance(facts.result)) {
    notes.push('skipped part: maintenance (converters none and the same coreSchemaVersion)');
  }
  return notes;
}

/**
 * PROD `## deploy`; `none` when `ogw build run` did not reach the end of step 5 (no `build-run.json`, or a check
 * failed before the server side and the PROD facts, which leaves `converters` null): the skip notes need those facts.
 */
export function prodDeployBody(orders: ProdOrders, facts: ProdDeployFacts): string {
  if (facts.result?.converters == null) return 'none';
  const deploy = orders.deploy.map((step, i) => `${String(i + 1)}. ${annotate(step, deployNotes(i + 1, facts))}`);
  const rollback = orders.rollback.map((step, i) => {
    const notes: string[] = [];
    if (i === 1) notes.push(`previous server image: ${facts.previousServerImage}`);
    if (i === 2) notes.push(`update.json: ${facts.updateJson ? `builds/${buildDirName('PROD', facts.version)}/update/update.json` : 'none'}`);
    return `${String(i + 1)}. ${annotate(step, notes)}`;
  });
  const wait = `match wait ms: ${String(facts.result.matchWaitMs ?? 'none')}`;
  return ['deploy order', '', ...deploy, '', 'rollback order', '', ...rollback, '', 'maintenance order', '', orders.maintenance, `   - ${wait}`].join('\n');
}

/** Lines of the `needs human` items of `records/loops/<run>/assumptions.md` on the branch. */
export async function needsHuman(game: GameRepo, branch: string, run: string): Promise<string[]> {
  const text = (await showFile(game.root, branch, `records/loops/${run}/assumptions.md`))?.toString('utf8') ?? '';
  return needsHumanLines(text);
}

/** Core proposal files added on the branch since the commit it was made from. */
export async function addedCoreProposals(game: GameRepo, base: string, branch: string): Promise<string[]> {
  const out = await git(game.root, ['diff', '--name-only', '--diff-filter=A', `${base}..${branch}`, '--', 'records/core-proposals/']);
  return out.split('\n').filter((line) => line.length > 0);
}

export function humanBody(result: BuildRunResult | null, assumptions: string[], proposals: string[]): string {
  const lines: string[] = [];
  for (const failure of result?.human ?? []) lines.push(`- ${failure.check}: ${failure.targets.join(', ')}`);
  for (const key of result?.licenseWarnings ?? []) lines.push(`- license warning: ${key}`);
  for (const line of assumptions) lines.push(`- ${line}`);
  for (const path of proposals) lines.push(`- core proposal: ${path}`);
  return lines.length === 0 ? 'none' : lines.join('\n');
}
