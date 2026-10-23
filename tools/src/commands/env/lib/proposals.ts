import { readFile, rm } from 'node:fs/promises';
import { STORE_LOGIN_TOKEN } from '../../secret/lib/login-token.ts';
import { AGENT_LOGIN_TOKEN_SECRET } from '../../secret/lib/names.ts';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { readJsonIfExists, writeFileAtomic } from '../../../lib/fsx.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { byteCompare } from '../../../lib/order.ts';
import { run } from '../../../lib/proc.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';
import type { GenerationMethod, GenerationPin, HarnessSettings, MeasuredStep, PythonToolPin, ToolPin } from '../../../lib/settings.ts';
import { schemaResourceTypes } from '../../generation/check.ts';
import { methodMarker, pinSecretAction, pipRequirements } from '../../generation/lib/install.ts';
import { NOT_INSTALLED } from '../../generation/measure.ts';
import { net, remoteCommit, requestJson } from './net.ts';
import { parseRequirement, parseVersion, compareVersions, isPrerelease } from './pep440.ts';
import { envResultPath, type HostPlatform } from './host.ts';
import { agentCliLabel, loginTokenError, loginTokenState, readEnvResult, type EnvResults, type MeasuredRun, type ProviderCliCheck } from './results.ts';
import { FIRST_PYTHON_MINOR, hostOf, markerFits, normalizeName, pinEntries, Pypi, resolveWheels, WHEEL_PLATFORMS, type PypiFile, type PypiProject, type ResolvedWheel } from './wheels.ts';

export interface Proposal {
  id: string;
  path: string;
  current: unknown;
  value: unknown;
  reason: string;
}

export interface Notice {
  id: string;
  detail: string;
}

interface Inputs {
  settings: HarnessSettings;
  check: EnvResults['env-check'] | null;
  install: EnvResults['generation-install'] | null;
  measure: EnvResults['generation-measure'] | null;
  instances: EnvResults['instance-measure'] | null;
}

/** The proposals the last `ogw env propose` showed, next to the result files it reads. */
export async function shownProposalsPath(env: NodeJS.ProcessEnv): Promise<string> {
  return join(dirname(await envResultPath(env, 'env-check')), 'env-propose.json');
}

/**
 * The last results and the harness settings. `update env` runs `ogw env check` first, so a result
 * older than the `env-check` result is from an earlier run and counts as no result.
 */
export async function readInputs(ctx: Context): Promise<Inputs> {
  const check = await readEnvResult(ctx, 'env-check');
  const since = check?.checkedAt;
  const thisRun = <T>(result: T | null, at: (r: T) => number): T | null => (result === null || since === undefined || at(result) >= since ? result : null);
  return {
    settings: await ctx.settings(),
    check,
    install: thisRun(await readEnvResult(ctx, 'generation-install'), (r) => r.installedAt),
    measure: thisRun(await readEnvResult(ctx, 'generation-measure'), (r) => r.measuredAt),
    instances: thisRun(await readEnvResult(ctx, 'instance-measure'), (r) => r.measuredAt),
  };
}

export function toMeasured(steps: readonly MeasuredRun[]): MeasuredStep[] {
  return steps.map((s) => ({
    ...(s.resolution === undefined ? {} : { resolution: s.resolution }),
    ...(s.durationMs === undefined ? {} : { durationMs: s.durationMs }),
    ...(s.jobMs === undefined ? {} : { jobMs: s.jobMs }),
    result: s.result,
  }));
}

const MEASURED_ID = 'measured:';

/**
 * The harness settings path of a proposal as segments. `measured.<method>` keeps the method name as one segment,
 * because a method name may have a `.`.
 */
export function proposalSegments(proposal: Proposal): string[] {
  return proposal.id.startsWith(MEASURED_ID) ? ['measured', proposal.id.slice(MEASURED_ID.length)] : proposal.path.split('.');
}

function measuredProposals(inputs: Inputs): Proposal[] {
  if (!inputs.measure) return [];
  const proposals: Proposal[] = [];
  for (const method of inputs.settings.resourceGeneration) {
    const result = inputs.measure.methods[method.name];
    if (!result || result.error !== null || result.steps.length === 0) continue;
    const value = toMeasured(result.steps);
    if (isDeepStrictEqual(value, method.measured)) continue;
    proposals.push({ id: `${MEASURED_ID}${method.name}`, path: `measured.${method.name}`, current: method.measured ?? null, value, reason: 'result of ogw generation measure' });
  }
  return proposals;
}

/** The smallest value of the targets `ogw instance measure` measured, or null when it measured none. */
function smallestInstances(inputs: Inputs): number | null {
  const targets = inputs.instances?.targets ?? [];
  return targets.length === 0 ? null : Math.min(...targets.map((t) => t.value));
}

/** True when the smallest measured value is below 2: this host cannot run the loop. */
function belowLoop(min: number | null): boolean {
  return min !== null && min < 2;
}

function instanceProposals(inputs: Inputs): Proposal[] {
  const min = smallestInstances(inputs);
  if (min === null || belowLoop(min)) return [];
  const proposals: Proposal[] = [];
  if (inputs.settings.maxConcurrentInstances !== min) {
    proposals.push({ id: 'maxConcurrentInstances', path: 'maxConcurrentInstances', current: inputs.settings.maxConcurrentInstances, value: min, reason: 'smallest instance count measured by ogw instance measure' });
  }
  if (min < inputs.settings.playInstances) {
    proposals.push({ id: 'playInstances', path: 'playInstances', current: inputs.settings.playInstances, value: min, reason: 'smaller than playInstances: the smallest instance count measured by ogw instance measure' });
  }
  return proposals;
}

const REGISTRY = 'https://registry-1.docker.io/v2/library/postgres';
const INDEX_TYPES = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json';

/** All tags of the Docker Official Image `postgres` from the registry API. */
async function postgresTags(token: string): Promise<string[]> {
  const tags: string[] = [];
  let url: string | null = `${REGISTRY}/tags/list?n=1000`;
  while (url !== null) {
    const response = await net().request(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status !== 200) throw new OgwError(`GET ${url} answered ${String(response.status)}`);
    tags.push(...((JSON.parse(response.body.toString('utf8')) as { tags?: string[] }).tags ?? []));
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.link ?? '')?.[1];
    url = next === undefined ? null : new URL(next, 'https://registry-1.docker.io').toString();
  }
  return tags;
}

async function postgresProposal(inputs: Inputs): Promise<Proposal[]> {
  const result = inputs.install?.tools.postgresql;
  if (!result || result.installed) return [];
  const current = inputs.settings.tools.postgresql;
  const major = current.tag.split('.')[0] as string;
  const { token } = await requestJson<{ token: string }>('https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/postgres:pull');
  const minors = (await postgresTags(token)).flatMap((t) => {
    const m = new RegExp(`^${major}\\.(\\d+)$`).exec(t);
    return m ? [Number(m[1])] : [];
  });
  if (minors.length === 0) return [];
  const tag = `${major}.${String(Math.max(...minors))}`;
  const head = await net().request(`${REGISTRY}/manifests/${tag}`, { method: 'HEAD', headers: { Authorization: `Bearer ${token}`, Accept: INDEX_TYPES } });
  const digest = head.headers['docker-content-digest'];
  if (head.status !== 200 || digest === undefined) throw new OgwError(`cannot read the digest of postgres:${tag}`);
  const value = { tag, digest };
  if (isDeepStrictEqual(value, current)) return [];
  return [{ id: 'tools.postgresql', path: 'tools.postgresql', current, value, reason: `ogw generation install could not pull the image; highest postgres ${major}.<minor> tag` }];
}

/**
 * The strings of a TOML array that starts at `text[0] === '['`, up to its closing bracket. `#` outside
 * a string starts a comment up to the end of the line. Throws when the array or a string is not closed.
 */
export function tomlStrings(text: string): string[] {
  const strings: string[] = [];
  let quote: string | null = null;
  let current = '';
  for (let i = 1; i < text.length; i++) {
    const c = text[i] as string;
    if (quote !== null) {
      if (c === '\\' && quote === '"') current += text[++i] ?? '';
      else if (c === quote) {
        strings.push(current);
        quote = null;
        current = '';
      } else current += c;
    } else if (c === '#') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ']') return strings;
  }
  throw new OgwError('pyproject.toml [project] dependencies: the array or a string is not closed');
}

/** `[project] dependencies` of a `pyproject.toml`. */
export function pyprojectDependencies(text: string): string[] {
  const project = /^\[project\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? '';
  const start = /^dependencies\s*=\s*\[/m.exec(project);
  if (!start) return [];
  return tomlStrings(project.slice(start.index + start[0].length - 1));
}

/** True when the marker (`''` for none) holds on the host platform with CPython `3.<minor>`. */
function holdsOn(marker: string, platform: HostPlatform, minor: number): boolean {
  return markerFits(marker === '' ? null : marker, hostOf(platform), minor, new Set());
}

/**
 * A specifier without the PEP 440 local version label of its version (`==2.7.1+cu128` -> `==2.7.1`): PyPI has no
 * release with a local label, so the requirement gets the PyPI release.
 */
function withoutLocalLabel(specifier: string): string {
  return specifier.replace(/\+[A-Za-z0-9.]*$/, '');
}

/** A pip pin item whose specifiers have local version labels, without them (`withoutLocalLabel`); any other item as it is. */
function pipItemWithoutLocalLabels(text: string): string {
  const requirement = parseRequirement(text);
  if (!requirement || requirement.url !== null || !requirement.specifiers.some((s) => withoutLocalLabel(s) !== s)) return text;
  return withMarker(`${requirement.name}${requirement.extras}${requirement.specifiers.map(withoutLocalLabel).join(',')}`, requirement.marker ?? '');
}

/** `requirement ; marker`, or the requirement alone for the marker `''`. */
function withMarker(requirement: string, marker: string): string {
  return marker === '' ? requirement : `${requirement} ; ${marker}`;
}

/** The marker that holds on the host platforms, which `sys_platform` tells apart. */
function onPlatforms(platforms: readonly HostPlatform[]): string {
  return platforms.map((p) => `sys_platform == '${hostOf(p).sys_platform}'`).join(' or ');
}

/**
 * CPython minor version of the isolated environment `ogw generation install` makes for a method: the
 * Python `uv venv` finds, which `uv python find --system` names. Like `uv venv`, `--system` skips the active virtual
 * environment (`VIRTUAL_ENV`) and a `.venv` above the working folder.
 */
async function venvPythonMinor(ctx: Context): Promise<number> {
  const options = { env: ctx.env, timeoutMs: LIMITS.shortMs };
  const found = await run('uv', ['python', 'find', '--system'], options).catch((error: unknown) => ({ code: null, stdout: '', stderr: (error as Error).message }));
  const python = found.stdout.trim();
  if (found.code !== 0 || python === '') throw new OgwError(`uv python find found no Python: ${found.stderr.trim()}`);
  const version = await run(python, ['--version'], options).catch(() => null);
  const minor = /^Python 3\.(\d+)/.exec(`${version?.stdout ?? ''}${version?.stderr ?? ''}`.trim())?.[1];
  if (version?.code !== 0 || minor === undefined) throw new OgwError(`cannot read the version of ${python}`);
  return Number(minor);
}

/**
 * True for an `https://` or `ssh://` URL without white space or control characters whose user and host do not start
 * with `-`. The repository comes from a third-party `pyproject.toml`, so git gets no option, local path or other
 * transport from it.
 */
function isRemoteRepository(repository: string): boolean {
  if (/[\s\p{Cc}]/u.test(repository)) return false;
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    return false;
  }
  return (url.protocol === 'https:' || url.protocol === 'ssh:') && url.hostname !== '' && !url.hostname.startsWith('-') && !url.username.startsWith('-');
}

/**
 * A `name @ url` requirement pinned to a commit: a `git+https://` or `git+ssh://` URL keeps its 40-character
 * commit, and any other ref (or no ref: HEAD) becomes the commit `remoteCommit` gives for it. The name keeps its
 * extras. Any other direct URL (not `git+`, or a repository that is not `https://` or `ssh://`) gives null.
 */
export async function pinDirectReference(text: string): Promise<string | null> {
  const at = text.indexOf(' @ ');
  // the name with its extras: `clip[train]`
  const name = text.slice(0, at);
  const url = text.slice(at + 3);
  const m = /^git\+([^#]+)(#.*)?$/.exec(url);
  if (!m) return null;
  const location = m[1] as string;
  const fragment = m[2] ?? '';
  const refAt = location.indexOf('@', location.lastIndexOf('/'));
  const repository = refAt === -1 ? location : location.slice(0, refAt);
  if (!isRemoteRepository(repository)) return null;
  const ref = refAt === -1 ? null : location.slice(refAt + 1);
  if (ref !== null && /^[0-9a-f]{40}$/.test(ref)) return text;
  let commit: string | null;
  try {
    commit = await remoteCommit(repository, ref ?? 'HEAD');
  } catch (error) {
    throw new OgwError(`dependency ${text}: ${(error as Error).message}`);
  }
  if (commit === null) throw new OgwError(`dependency ${text}: git ls-remote ${repository} ${ref ?? 'HEAD'} found no commit`);
  return `${name} @ git+${repository}@${commit}${fragment}`;
}

/** The target `uv pip compile --python-platform` resolves for each host platform. */
const UV_PLATFORMS: Record<HostPlatform, string> = { 'macos-arm64': 'aarch64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-gnu', 'windows-x64': 'x86_64-pc-windows-msvc' };

/** The lowest macOS version the macos-arm64 resolution targets (`MACOSX_DEPLOYMENT_TARGET` of `uv pip compile`). */
const MACOS_TARGET = '14.0';

/**
 * The `pyproject.toml` dependencies to resolve: each that holds on some host platform (`WHEEL_PLATFORMS`) with CPython
 * `3.<minor>` and whose project the pip pins do not name (`named`), its specifiers without local version labels, and
 * each `name @ git+URL` pinned to a commit. A project PyPI does not have is left out and named in `notOnPypi`; a
 * direct reference `pinDirectReference` cannot pin is left out and named in `unpinned`. `added` names the projects of
 * `requirements`.
 */
async function dependencyRequirements(
  pypi: Pypi,
  dependencies: readonly string[],
  named: ReadonlySet<string>,
  minor: number,
): Promise<{ requirements: string[]; added: string[]; notOnPypi: string[]; unpinned: string[] }> {
  const requirements: string[] = [];
  const added = new Map<string, string>();
  const notOnPypi = new Map<string, string>();
  const unpinned = new Set<string>();
  for (const text of dependencies) {
    const requirement = parseRequirement(text);
    if (!requirement) throw new OgwError(`cannot read dependency: ${text}`);
    const key = normalizeName(requirement.name);
    const marker = requirement.marker ?? '';
    if (named.has(key) || !WHEEL_PLATFORMS.some((platform) => holdsOn(marker, platform, minor))) continue;
    if (requirement.url !== null) {
      const reference = `${requirement.name}${requirement.extras.replace(/\s+/g, '')} @ ${requirement.url}`;
      const pinned = await pinDirectReference(reference);
      if (pinned === null) {
        unpinned.add(reference);
        continue;
      }
      requirements.push(withMarker(pinned, marker));
    } else if (notOnPypi.has(key) || (!added.has(key) && (await pypi.projectIfExists(key)) === null)) {
      if (!notOnPypi.has(key)) notOnPypi.set(key, requirement.name);
      continue;
    } else {
      requirements.push(withMarker(`${requirement.name}${requirement.extras}${requirement.specifiers.map(withoutLocalLabel).join(',')}`, marker));
    }
    if (!added.has(key)) added.set(key, requirement.name);
  }
  return { requirements, added: [...added.values()], notOnPypi: [...notOnPypi.values()], unpinned: [...unpinned] };
}

/**
 * The exact requirement (`name==version`, or `name @ url`) of every package, transitive ones included, that
 * `uv pip compile` resolves the requirements to on the host platform with CPython `3.<minor>`, by normalized name.
 * uv runs in a new private temp folder with no uv config file; a failed resolution fails with uv's message.
 */
async function compileFor(ctx: Context, requirements: readonly string[], platform: HostPlatform, minor: number): Promise<Map<string, string>> {
  const dir = await newPrivateTempFolder('ogw-uv-compile-', ctx.env);
  try {
    const input = join(dir, 'requirements.in');
    const output = join(dir, 'requirements.txt');
    await writeFileAtomic(input, `${requirements.join('\n')}\n`);
    const python = `3.${String(minor)}`;
    const args = ['--no-config', 'pip', 'compile', input, '--python-platform', UV_PLATFORMS[platform], '--python-version', python, '--no-header', '--no-annotate', '--output-file', output];
    const env = platform === 'macos-arm64' ? { ...ctx.env, MACOSX_DEPLOYMENT_TARGET: MACOS_TARGET } : ctx.env;
    const result = await run('uv', args, { cwd: dir, env, timeoutMs: LIMITS.programMs }).catch((error: unknown) => ({ code: null, stdout: '', stderr: (error as Error).message }));
    if (result.code !== 0) throw new OgwError(`uv pip compile for ${platform} CPython ${python} failed: ${(result.stderr.trim() || result.stdout.trim())}`);
    const pins = new Map<string, string>();
    for (const line of (await readFile(output, 'utf8')).split('\n')) {
      const text = line.replace(/\s+#.*$/, '').trim();
      if (text === '' || text.startsWith('#') || text.startsWith('-')) continue;
      const requirement = parseRequirement(text);
      if (!requirement) throw new OgwError(`uv pip compile for ${platform} CPython ${python}: cannot read ${text}`);
      pins.set(normalizeName(requirement.name), text);
    }
    return pins;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The requirements of one pip pin source from the resolution of each host platform, in normalized name order: a
 * requirement every host platform resolves to the same text has no marker; any other gets one entry per text, with
 * the `sys_platform` marker of the host platforms that resolve to it.
 */
export function mergePlatformPins(resolved: ReadonlyMap<HostPlatform, ReadonlyMap<string, string>>): string[] {
  const names = [...new Set([...resolved.values()].flatMap((pins) => [...pins.keys()]))].sort(byteCompare);
  return names.flatMap((name) => {
    const platformsOf = new Map<string, HostPlatform[]>();
    for (const platform of WHEEL_PLATFORMS) {
      const text = resolved.get(platform)?.get(name);
      if (text !== undefined) platformsOf.set(text, [...(platformsOf.get(text) ?? []), platform]);
    }
    const everywhere = platformsOf.size === 1 && [...platformsOf.values()][0]?.length === WHEEL_PLATFORMS.length;
    return [...platformsOf].map(([text, platforms]) => (everywhere ? text : withMarker(text, onPlatforms(platforms))));
  });
}

/**
 * `uv pip compile` of the requirements for each host platform (`compileFor`), together. A host platform that cannot
 * resolve is left out and named in `failed` (the method gets no packages there); fails when no host platform resolves.
 */
async function compileAll(ctx: Context, requirements: readonly string[], minor: number): Promise<{ resolved: Map<HostPlatform, Map<string, string>>; failed: string[] }> {
  const results = await Promise.allSettled(WHEEL_PLATFORMS.map((platform) => compileFor(ctx, requirements, platform, minor)));
  const resolved = new Map<HostPlatform, Map<string, string>>();
  const failed: string[] = [];
  for (const [i, result] of results.entries()) {
    const platform = WHEEL_PLATFORMS[i] as HostPlatform;
    if (result.status === 'fulfilled') resolved.set(platform, result.value);
    else failed.push(`${platform}: ${causeLine(result.reason)}`);
  }
  if (resolved.size === 0) throw results.find((r) => r.status === 'rejected')?.reason;
  return { resolved, failed };
}

/** The reason line of a uv resolution failure (`cause:` or `╰─▶`), or its first line, without the `compileFor` prefix. */
function causeLine(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/^uv pip compile for \S+ CPython \S+ failed: /, '');
  const cause = /(?:cause:|╰─▶)\s*(.+)/.exec(text)?.[1];
  return (cause ?? text.split('\n')[0] ?? '').trim();
}

function revisionless(pin: GenerationPin): boolean {
  return pin.kind === 'git' && pin.revision === undefined;
}

/**
 * True for a git pin whose `pyproject.toml` dependencies the method's pip pins must name: a pin without revision, and
 * any git pin of a `local-model` method, whose checkout is used from `PYTHONPATH` and never installed.
 */
function readsDependencies(method: GenerationMethod, pin: GenerationPin): boolean {
  return pin.kind === 'git' && (pin.revision === undefined || method.kind === 'local-model');
}


/** The pins with the first pip pin's source replaced by `source` and the other pip pins left out, or a new pip pin at the end. */
function withPipSource(pins: readonly GenerationPin[], source: string): GenerationPin[] {
  const first = pins.findIndex((p) => p.kind === 'pip');
  if (first === -1) return [...pins, { kind: 'pip', source }];
  return pins.flatMap((pin, index) => (index === first ? [{ ...pin, source }] : pin.kind === 'pip' ? [] : [pin]));
}

/**
 * `pin:<method>`: each git pin without revision gets the HEAD commit of the default branch. The pip pins and the
 * `pyproject.toml` dependencies at the commit of each git pin `readsDependencies` names, whose projects the pip pins
 * do not name (`dependencyRequirements`), are resolved with `uv pip compile` for each host platform, and the merged
 * result (`mergePlatformPins`) becomes the one pip pin.
 */
/**
 * The pip pin source that `uv pip compile` resolves the pyproject.toml dependencies and the other pip pin items to,
 * and the reasons; the dependencies win over pip pin items of the same project, which are a previous resolution.
 */
async function resolvedPip(ctx: Context, pypi: Pypi, pins: readonly GenerationPin[], dependencies: readonly string[]): Promise<{ source: string | null; reasons: string[] }> {
  const dependencyProjects = new Set(
    dependencies.flatMap((text) => {
      const requirement = parseRequirement(text);
      return requirement ? [normalizeName(requirement.name)] : [];
    }),
  );
  const pip = pins
    .filter((p) => p.kind === 'pip')
    .flatMap((p) => pipRequirements(p.source))
    .filter((text) => !dependencyProjects.has(normalizeName(parseRequirement(text)?.name ?? '')))
    .map(pipItemWithoutLocalLabels);
  if (pip.length === 0 && dependencies.length === 0) return { source: null, reasons: [] };
  const minor = await venvPythonMinor(ctx);
  const { requirements, added, notOnPypi, unpinned } = await dependencyRequirements(pypi, dependencies, new Set<string>(), minor);
  const reasons: string[] = [];
  let source: string | null = null;
  if (pip.length + requirements.length > 0) {
    const compiled = await compileAll(ctx, [...pip, ...requirements], minor);
    source = mergePlatformPins(compiled.resolved).join(',');
    const extra = added.length === 0 ? '' : ` with the pyproject.toml dependencies (${added.join(', ')}), which win over pip pin items of the same project,`;
    reasons.push(`pip pins${extra} resolved with uv pip compile for ${WHEEL_PLATFORMS.join(', ')} CPython 3.${String(minor)}`);
    if (compiled.failed.length > 0) reasons.push(`no packages where the dependencies cannot be resolved: ${compiled.failed.join('; ')}`);
  }
  if (notOnPypi.length > 0) reasons.push(`not on PyPI, left out: ${notOnPypi.join(', ')}`);
  if (unpinned.length > 0) reasons.push(`direct URL that is not a git+https:// or git+ssh:// repository, left out: ${unpinned.join('; ')}`);
  return { source, reasons };
}

async function pinProposal(ctx: Context, pypi: Pypi, method: GenerationMethod, index: number): Promise<Proposal | null> {
  const pins = method.pins ?? [];
  if (!pins.some((p) => readsDependencies(method, p))) return null;
  const open = pins.filter(revisionless).map((p) => p.source);
  let value: GenerationPin[] = [];
  const dependencies: string[] = [];
  for (const pin of pins) {
    if (!readsDependencies(method, pin)) {
      value.push(pin);
      continue;
    }
    const revision = pin.revision ?? (await remoteCommit(pin.source, 'HEAD'));
    if (revision === null) throw new OgwError(`git ls-remote ${pin.source} HEAD found no commit`);
    value.push({ ...pin, revision });
    const pyproject = await net().gitFile(pin.source, revision, pin.pyproject ?? 'pyproject.toml');
    if (pyproject !== null) dependencies.push(...pyprojectDependencies(pyproject));
  }
  const reasons = open.length === 0 ? [] : [`git pins without revision (${open.join(', ')}): HEAD of the default branch`];
  const resolved = await resolvedPip(ctx, pypi, pins, dependencies);
  if (resolved.source !== null) value = withPipSource(value, resolved.source);
  reasons.push(...resolved.reasons);
  if (isDeepStrictEqual(value, pins)) return null;
  return { id: `pin:${method.name}`, path: `resourceGeneration.${String(index)}.pins`, current: pins, value, reason: reasons.join('; ') };
}

async function pinProposals(ctx: Context, pypi: Pypi, inputs: Inputs, wanted: (id: string) => boolean): Promise<Proposal[]> {
  const proposals: Proposal[] = [];
  for (const [index, method] of inputs.settings.resourceGeneration.entries()) {
    if (!wanted(`pin:${method.name}`)) continue;
    const proposal = await pinProposal(ctx, pypi, method, index);
    if (proposal) proposals.push(proposal);
  }
  return proposals;
}

/** hf pins without `sha256` of an installed method get the SHA-256 of the files `ogw generation install` got. */
async function sha256Proposal(ctx: Context, method: GenerationMethod, index: number): Promise<Proposal | null> {
  const pins = method.pins ?? [];
  if (!pins.some((p) => p.kind === 'hf' && p.sha256 === undefined)) return null;
  const marker = await methodMarker(ctx, method);
  if (marker === null) return null;
  let hf = 0;
  const value = pins.map((pin) => {
    if (pin.kind !== 'hf') return pin;
    const digest = marker.hf[hf++]?.sha256;
    return pin.sha256 === undefined && digest !== undefined ? { ...pin, sha256: digest } : pin;
  });
  if (isDeepStrictEqual(value, pins)) return null;
  return {
    id: `sha256:${method.name}`,
    path: `resourceGeneration.${String(index)}.pins`,
    current: pins,
    value,
    reason: 'hf pin has no sha256: SHA-256 of the files ogw generation install got',
  };
}

/** Only the methods the `ogw generation install` result of this run lists as installed. */
async function sha256Proposals(ctx: Context, inputs: Inputs): Promise<Proposal[]> {
  const proposals: Proposal[] = [];
  for (const [index, method] of inputs.settings.resourceGeneration.entries()) {
    if (inputs.install?.methods[method.name]?.installed !== true) continue;
    const proposal = await sha256Proposal(ctx, method, index);
    if (proposal) proposals.push(proposal);
  }
  return proposals;
}

/** Major version of `godot` in `open-game-works-core-impl/client/godot/engine.json` (`4.5.stable`, `4.5.1.stable`). */
async function godotMajor(ctx: Context): Promise<number | null> {
  const json = await readJsonIfExists<{ godot?: unknown }>(join((await ctx.workspace()).coreImpl, 'client', 'godot', 'engine.json'));
  const major = typeof json?.godot === 'string' ? /^(\d+)\./.exec(json.godot)?.[1] : undefined;
  return major === undefined ? null : Number(major);
}

/** The highest release version with that major that has a `-none-any.whl` file not yanked. */
export function highestAnyWheel(project: PypiProject, major: number): { version: string; file: PypiFile } | null {
  let best: { version: string; file: PypiFile; parsed: ReturnType<typeof parseVersion> } | null = null;
  for (const [version, files] of Object.entries(project.releases)) {
    const parsed = parseVersion(version);
    const file = files.find((f) => f.filename.endsWith('-none-any.whl') && f.yanked !== true);
    if (!parsed || isPrerelease(parsed) || parsed.release[0] !== major || !file) continue;
    if (best?.parsed && compareVersions(parsed, best.parsed) <= 0) continue;
    best = { version, file, parsed };
  }
  return best === null ? null : { version: best.version, file: best.file };
}

/** The highest CPython minor named by a wheel read so far that is not tried yet and above `floor`. */
function nextMinor(pypi: Pypi, tried: ReadonlySet<number>, floor: number): number | undefined {
  return [...pypi.cpythonMinors()].filter((m) => m > floor && !tried.has(m)).sort((a, b) => b - a)[0];
}

/**
 * A gdtoolkit pin: the wheel, the highest CPython minor version where every dependency has a wheel on
 * every platform, and those wheels. The minors tried are `FIRST_PYTHON_MINOR` and then those named by
 * the `cp3<minor>` tags of the wheels of the projects read, from the highest.
 */
export async function gdtoolkitPin(version: string, pypi: Pypi = new Pypi()): Promise<PythonToolPin> {
  const problems: string[] = [];
  const tried = new Set<number>();
  let best: { minor: number; pin: PythonToolPin } | null = null;
  for (let minor: number | undefined = FIRST_PYTHON_MINOR; minor !== undefined; minor = nextMinor(pypi, tried, best?.minor ?? -1)) {
    tried.add(minor);
    try {
      const perPlatform = new Map<HostPlatform, ResolvedWheel[]>();
      for (const platform of WHEEL_PLATFORMS) perPlatform.set(platform, await resolveWheels(pypi, { name: 'gdtoolkit', version }, platform, minor));
      best = { minor, pin: { version, python: `3.${String(minor)}`, ...pinEntries(perPlatform) } };
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  if (best !== null) return best.pin;
  throw new OgwError(`no CPython 3.x has wheels of gdtoolkit ${version} and its dependencies on every platform: ${problems.join('; ')}`);
}

async function gdtoolkitProposal(ctx: Context, pypi: Pypi, inputs: Inputs): Promise<Proposal[]> {
  const current = inputs.settings.tools.gdtoolkit;
  const failed = inputs.install?.tools.gdtoolkit?.installed === false;
  if (current !== undefined && !failed) return [];
  const major = await godotMajor(ctx);
  if (major === null) return [];
  const best = highestAnyWheel(await pypi.project('gdtoolkit'), major);
  if (best === null) return [];
  const value = await gdtoolkitPin(best.version, pypi);
  if (isDeepStrictEqual(value, current)) return [];
  const why = current === undefined ? 'tools.gdtoolkit is missing' : 'ogw generation install could not get tools.gdtoolkit';
  return [{ id: 'tools.gdtoolkit', path: 'tools.gdtoolkit', current: current ?? null, value, reason: `${why}; highest gdtoolkit ${String(major)}.x any wheel and its dependency wheels` }];
}

/** The fixed source of the `tools.ffmpeg` proposal: a GitHub release of static builds with the `libvorbis` encoder. */
export const FFMPEG_SOURCE = {
  repository: 'eugeneware/ffmpeg-static',
  tag: 'b6.1.1',
  assets: { 'macos-arm64': 'ffmpeg-darwin-arm64', 'linux-x64': 'ffmpeg-linux-x64', 'windows-x64': 'ffmpeg-win32-x64' } as Record<HostPlatform, string>,
};

interface GithubRelease {
  assets?: { name: string; browser_download_url: string; digest?: string | null }[];
}

/** `tools.ffmpeg` from the fixed source: each asset URL and the SHA-256 GitHub gives as the asset digest. */
export async function ffmpegPin(): Promise<ToolPin> {
  const release = await requestJson<GithubRelease>(`https://api.github.com/repos/${FFMPEG_SOURCE.repository}/releases/tags/${FFMPEG_SOURCE.tag}`);
  const downloads = WHEEL_PLATFORMS.map((platform) => {
    const name = FFMPEG_SOURCE.assets[platform];
    const asset = (release.assets ?? []).find((a) => a.name === name);
    const sha256 = /^sha256:([0-9a-f]{64})$/.exec(asset?.digest ?? '')?.[1];
    if (asset === undefined || sha256 === undefined) throw new OgwError(`release ${FFMPEG_SOURCE.repository} ${FFMPEG_SOURCE.tag} has no asset ${name} with a sha256 digest`);
    return { platform, url: asset.browser_download_url, sha256 };
  });
  return { version: `${FFMPEG_SOURCE.repository} ${FFMPEG_SOURCE.tag}`, downloads };
}

async function ffmpegProposal(inputs: Inputs): Promise<Proposal[]> {
  const current = inputs.settings.tools.ffmpeg;
  const failed = inputs.install?.tools.ffmpeg?.installed === false;
  if (current !== undefined && !failed) return [];
  const value = await ffmpegPin();
  if (isDeepStrictEqual(value, current)) return [];
  const why = current === undefined ? 'tools.ffmpeg is missing' : 'ogw generation install could not get tools.ffmpeg';
  return [{ id: 'tools.ffmpeg', path: 'tools.ffmpeg', current: current ?? null, value, reason: `${why}; ffmpeg static build of ${FFMPEG_SOURCE.repository} ${FFMPEG_SOURCE.tag}` }];
}

/** The proposals. With `only`, the proposals that need a lookup are computed only for those ids. */
export async function computeProposals(ctx: Context, inputs: Inputs, only?: ReadonlySet<string>): Promise<Proposal[]> {
  const wanted = (id: string): boolean => only === undefined || only.has(id);
  const pypi = new Pypi();
  return [
    ...measuredProposals(inputs),
    ...instanceProposals(inputs),
    ...(wanted('tools.postgresql') ? await postgresProposal(inputs) : []),
    ...(await pinProposals(ctx, pypi, inputs, wanted)),
    ...(await sha256Proposals(ctx, inputs)),
    ...(wanted('tools.gdtoolkit') ? await gdtoolkitProposal(ctx, pypi, inputs) : []),
    ...(wanted('tools.ffmpeg') ? await ffmpegProposal(inputs) : []),
  ];
}

/**
 * A method makes something when its steps have an `ok`: the steps of this measure result, or the
 * harness settings `measured` of a method step 4 did not call (no result, or an external-service
 * method it did not call). A method with a measure error makes nothing.
 */
function hasOk(inputs: Inputs, method: GenerationMethod): boolean {
  const measured = inputs.measure?.methods[method.name];
  const notCalled = measured === undefined || (method.kind === 'external-service' && measured.error !== null && measured.error !== NOT_INSTALLED);
  const steps = notCalled ? (method.measured ?? []) : measured.steps;
  return steps.some((s) => s.result === 'ok');
}

function dockerNotice(check: NonNullable<Inputs['check']>): Notice[] {
  const parts = [
    ...(check.programs.docker?.found === true ? [] : ['Docker is missing']),
    ...(check.programs.dockerBuildx?.found === true ? [] : ['docker buildx is missing']),
    ...(check.gh.scopes.includes('write:packages') ? [] : ['GitHub CLI login has no write:packages scope']),
  ];
  if (parts.length === 0) return [];
  return [{ id: 'docker', detail: `${parts.join('; ')}. Install them or log in with gh auth refresh --scopes write:packages` }];
}

/** The `agent-login-token` notice: the token is missing, Claude Code rejected it, or its token check run failed otherwise. */
function loginTokenNotice(check: NonNullable<Inputs['check']>): Notice[] {
  const token = check.agentLoginToken?.needed === true ? check.agentLoginToken : null;
  const state = token === null ? null : loginTokenState(token);
  if (token === null || state === null || state === 'valid') return [];
  const output = loginTokenError(token);
  const role = token.run?.role ?? '';
  const invalid =
    typeof token.valueProblem === 'string'
      ? `harness secret ${AGENT_LOGIN_TOKEN_SECRET} is ${output} (invalid). ${STORE_LOGIN_TOKEN}`
      : `Claude Code failed to authenticate with harness secret ${AGENT_LOGIN_TOKEN_SECRET} in the ${role} agent sandbox (invalid): ${output}. ${STORE_LOGIN_TOKEN}`;
  const detail = {
    missing: `harness secret ${AGENT_LOGIN_TOKEN_SECRET} is not in the host secret store (missing): ${STORE_LOGIN_TOKEN}. Without it ogw loop start and ogw build start do not start`,
    invalid,
    unverified: `the Claude Code run with harness secret ${AGENT_LOGIN_TOKEN_SECRET} in the ${role} agent sandbox failed without an authentication failure (unverified): ${output}. Check this error`,
  }[state];
  return [{ id: 'agent-login-token', detail }];
}

/** The login that makes the calls of a provider use its subscription. */
const SUBSCRIPTION_LOGIN: Record<string, string> = { codex: 'a ChatGPT login (codex login)', grok: 'a Grok login (grok login)' };

/** `provider-cli`: the CLI is not installed or not logged in, or its calls are billed per call or may be. */
function providerCliNotice(cli: ProviderCliCheck): Notice[] {
  const problems: string[] = [];
  const actions: string[] = [];
  if (!cli.installed || cli.loggedIn !== true) {
    problems.push(`${cli.provider} CLI is ${cli.installed ? 'not logged in' : 'not installed'}`);
    actions.push('Install it and log in');
  }
  if (cli.billing === 'per-call') {
    problems.push(`${cli.provider} calls are billed per call (${cli.detail ?? ''})`);
    actions.push(`Tell the human before allowing those calls; ${SUBSCRIPTION_LOGIN[cli.provider] ?? 'a subscription login'} makes them use the subscription instead`);
  } else if (cli.billing === null && cli.installed && cli.loggedIn === true) {
    problems.push(`whether ${cli.provider} calls are billed per call is unknown (${cli.detail ?? ''})`);
    actions.push('A human has to check how this login bills calls before allowing them');
  }
  if (problems.length === 0) return [];
  return [{ id: 'provider-cli', detail: `${problems.join('; ')}; used by ${cli.methods.join(', ')}. ${actions.join('. ')}` }];
}

function checkNotices(check: Inputs['check']): Notice[] {
  if (!check) return [];
  const notices: Notice[] = dockerNotice(check);
  const udp = check.testDevices.filter((d) => d.udp === false).map((d) => d.serial);
  if (udp.length > 0) notices.push({ id: 'udp', detail: `UDP does not reach this host from: ${udp.join(', ')}. Put the devices on the same LAN as the host` });
  for (const cli of check.agentClis.filter((a) => a.run?.ok !== true)) {
    notices.push({ id: 'agent-cli', detail: `${agentCliLabel(cli)} did not finish in an empty folder: ${cli.run?.output ?? ''}` });
  }
  notices.push(...check.providerClis.flatMap(providerCliNotice));
  notices.push(...loginTokenNotice(check));
  for (const s of (check.pinSecrets ?? []).filter((p) => !p.stored)) {
    notices.push({ id: 'pin-secret', detail: `harness secret ${s.secret} of hf pin ${s.source} (${s.method}) is not in the host secret store: ${pinSecretAction({ kind: 'hf', source: s.source, secret: s.secret })}` });
  }
  return notices;
}

export async function computeNotices(ctx: Context, inputs: Inputs): Promise<Notice[]> {
  const notices: Notice[] = [];
  const targets = inputs.instances?.targets;
  if (targets?.length === 0) notices.push({ id: 'no-benchmark', detail: 'ogw instance measure had no target. Run update env again after create client core' });
  if (belowLoop(smallestInstances(inputs))) {
    notices.push({ id: 'no-loop', detail: 'the smallest measured instance count is below 2. This host cannot run the loop' });
  }
  if (inputs.measure) {
    const methods = inputs.settings.resourceGeneration;
    const missing = (await schemaResourceTypes(ctx.env)).filter((type) => !methods.some((m) => m.resourceTypes.includes(type) && hasOk(inputs, m)));
    if (missing.length > 0) notices.push({ id: 'no-method', detail: `no method makes: ${missing.join(', ')}` });
  }
  return [...notices, ...checkNotices(inputs.check)];
}
