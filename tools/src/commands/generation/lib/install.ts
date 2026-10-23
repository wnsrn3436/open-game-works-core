import { chmod, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { exists, readJsonIfExists, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import { gitRaw } from '../../../lib/git.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { withLock } from '../../../lib/lock.ts';
import { runOk } from '../../../lib/proc.ts';
import { harnessSecretService } from '../../../lib/secrets.ts';
import type { GenerationMethod, GenerationPin } from '../../../lib/settings.ts';
import { toolProgram } from '../../env/api.ts';
import { findFile, sha256File, sha256Text } from '../../env/lib/files.ts';
import { dataDir, safeSegment } from '../../env/lib/host.ts';
import { InstallFailure, installLockPath, refillFolder, venvProgram } from '../../env/lib/install.ts';
import { net, requestJson } from '../../env/lib/net.ts';
import type { InstallEntry } from '../../env/lib/results.ts';
import { byteCompare } from '../../../lib/order.ts';

/** `installed.json` of a generation method folder, written last. */
export interface MethodMarker {
  name: string;
  /** JSON of the method `pins` the folder was installed from. */
  pins: string;
  /** Checkout folder of each git pin, in pin order. */
  git: { source: string; dir: string; revision: string }[];
  /** Folder of each hf pin, in pin order, and the hf SHA-256 of the files it got (the `sha256` text format of the pin). */
  hf: { source: string; dir: string; sha256?: string }[];
  /** Folder of `file` pins. */
  files: string | null;
  /** Python of the method's isolated environment, when it has one. */
  python: string | null;
  /** Executable the install made for a `provider` external-service. */
  cli: string | null;
  /** `SKILL.md` of the git repository of a `provider` external-service. */
  skill: string | null;
  /** The `tools.ffmpeg` program whose folder the `cli` puts at the front of PATH. */
  ffmpeg?: string | null;
}

export async function methodDir(ctx: Context, name: string): Promise<string> {
  return join(await dataDir(ctx), 'generation', safeSegment(name));
}

/**
 * True when the marker was installed from these pins. An hf `sha256` added after the install that equals the
 * SHA-256 of the files the install got keeps the install, so the `sha256:<method>` proposal does not download again.
 */
export function installedFrom(marker: MethodMarker, pins: readonly GenerationPin[]): boolean {
  if (marker.pins === JSON.stringify(pins)) return true;
  let hf = 0;
  const beforeAdded = pins.map((pin) => {
    if (pin.kind !== 'hf') return pin;
    const digest = marker.hf[hf++]?.sha256;
    if (pin.sha256 === undefined || pin.sha256 !== digest) return pin;
    const rest: GenerationPin = { ...pin };
    delete rest.sha256;
    return rest;
  });
  return marker.pins === JSON.stringify(beforeAdded);
}

/**
 * The method's install marker when it was installed from its current pins and, for a `provider` method, its
 * `cli` puts the currently installed `tools.ffmpeg` on PATH.
 */
export async function methodMarker(ctx: Context, method: GenerationMethod): Promise<MethodMarker | null> {
  const marker = await readJsonIfExists<MethodMarker>(join(await methodDir(ctx, method.name), 'installed.json'));
  if (!marker || !installedFrom(marker, method.pins ?? [])) return null;
  if (marker.cli !== null && marker.ffmpeg !== (await toolProgram(ctx, 'ffmpeg'))) return null;
  return marker;
}

/**
 * Runs `fn` under the lock of the method folder. `generation install` holds it while it empties and refills the
 * folder; `generation run` and `generation measure` hold it while a call uses the folder.
 */
export async function withMethodLock<T>(ctx: Context, name: string, fn: () => Promise<T>): Promise<T> {
  return withLock(installLockPath(await methodDir(ctx, name)), fn, LIMITS.jobMs);
}

/** True for the kinds `generation install` downloads pins for. */
export function hasPins(method: GenerationMethod): boolean {
  return method.kind === 'local-model' || method.kind === 'catalog' || (method.kind === 'external-service' && method.provider !== undefined);
}

async function gitIn(dir: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await gitRaw(dir, args, { timeoutMs: LIMITS.programMs, env });
  if (result.code !== 0) throw new InstallFailure(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

async function installGit(pin: GenerationPin, dir: string, env: NodeJS.ProcessEnv): Promise<{ source: string; dir: string; revision: string }> {
  const revision = pin.revision as string;
  await mkdir(dir, { recursive: true });
  await gitIn(dir, ['init', '--quiet'], env);
  await gitIn(dir, ['remote', 'add', 'origin', pin.source], env);
  if (pin.files) {
    const paths = pin.files.split(',').map((p) => `/${p.trim().replace(/^\/+/, '')}`);
    await gitIn(dir, ['sparse-checkout', 'set', '--no-cone', ...paths], env);
  }
  await gitIn(dir, ['fetch', '--quiet', '--depth', '1', 'origin', revision], env);
  await gitIn(dir, ['checkout', '--quiet', 'FETCH_HEAD'], env);
  const actual = await gitIn(dir, ['rev-parse', 'HEAD'], env);
  if (actual !== revision) {
    throw new InstallFailure(`git ${pin.source} is at ${actual}, not ${revision}`, [{ what: pin.source, path: dir, expected: revision, actual }]);
  }
  return { source: pin.source, dir, revision };
}

async function applyPatch(ctx: Context, pin: GenerationPin, gitDir: string | undefined): Promise<void> {
  if (gitDir === undefined) throw new InstallFailure(`patch ${pin.source} has no git pin before it`);
  const file = join((await ctx.workspace()).harness, pin.source);
  if (!exists(file)) throw new InstallFailure(`patch file not found: ${file}`);
  const actual = await sha256File(file);
  if (pin.sha256 !== undefined && actual !== pin.sha256) {
    throw new InstallFailure(`patch ${pin.source} SHA-256 differs`, [{ what: pin.source, path: file, expected: pin.sha256, actual }]);
  }
  await gitIn(gitDir, ['apply', file], ctx.env);
}

/** fnmatch: `*` matches any text including `/`, `?` one character. */
export function globMatch(pattern: string, path: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`).test(path);
}

function patterns(text: string | undefined): string[] {
  return (text ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/**
 * The requirements of a pip pin source: its comma list, where a comma inside the extras `[a,b]` of a name or inside
 * a quoted value of a marker does not split.
 */
export function pipRequirements(text: string): string[] {
  const requirements: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const c of text) {
    if (quote !== null) {
      if (c === quote) quote = null;
      current += c;
      continue;
    }
    if (c === ',' && depth === 0) {
      requirements.push(current);
      current = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    current += c;
  }
  requirements.push(current);
  return requirements.map((r) => r.trim()).filter((r) => r !== '');
}

/** SHA-256 of the lines `<relative path> <SHA-256>` in path order, each line ending with a newline. */
export function hfDigest(entries: { path: string; sha256: string }[]): string {
  const lines = [...entries].sort((a, b) => byteCompare(a.path, b.path)).map((e) => `${e.path} ${e.sha256}\n`);
  return sha256Text(lines.join(''));
}

/** What the human does to give an hf pin with `secret` access to its gated repository. */
export function pinSecretAction(pin: GenerationPin): string {
  return `accept the license on https://huggingface.co/${pin.source} with a Hugging Face account, then put an access token of that account in the host secret store: ogw secret set --harness ${String(pin.secret)}`;
}

interface HfInfo {
  sha?: string;
  /** With `blobs=true`, a file stored with LFS carries its SHA-256. */
  siblings?: { rfilename: string; lfs?: { sha256?: string } }[];
}

async function hfInfo(pin: GenerationPin, revision: string, headers: Record<string, string> | undefined): Promise<HfInfo> {
  const url = `https://huggingface.co/api/models/${pin.source}/revision/${revision}?blobs=true`;
  if (pin.secret !== undefined) {
    const response = await net().request(url, { headers });
    if (response.status === 401 || response.status === 403) {
      throw new InstallFailure(`hf ${pin.source} answered ${String(response.status)} to the token in harness secret ${pin.secret}: ${pinSecretAction(pin)}`);
    }
  }
  return requestJson<HfInfo>(url, headers);
}

/** Moves the file `from` to `to` when its SHA-256 is `expected`; otherwise removes it. True when moved. */
async function reuseFile(from: string, to: string, expected: string): Promise<boolean> {
  if (!exists(from)) return false;
  if ((await sha256File(from)) !== expected) {
    await rm(from, { force: true });
    return false;
  }
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
  return true;
}

/**
 * Downloads the wanted files of an hf pin. Files without an LFS SHA-256 (small text files) come first, so a pin whose
 * SHA-256 cannot match fails before any large file is downloaded; each LFS file is checked against its published
 * SHA-256 as soon as it arrives. An LFS file in the folder `reuse` whose SHA-256 is the published one is moved into
 * place instead of downloaded; its other files at the paths of wanted files are removed. `lfs` receives the path of
 * each LFS file in place whose SHA-256 is the published one.
 */
async function downloadHfFiles(
  pin: GenerationPin,
  revision: string,
  dir: string,
  headers: Record<string, string> | undefined,
  wanted: readonly string[],
  info: HfInfo,
  reuse: string | null,
  lfs: string[],
): Promise<{ path: string; sha256: string }[]> {
  const published = new Map((info.siblings ?? []).flatMap((s) => (s.lfs?.sha256 === undefined ? [] : [[s.rfilename, s.lfs.sha256] as const])));
  const small = wanted.filter((p) => !published.has(p));
  const large = wanted.filter((p) => published.has(p));
  const entries: { path: string; sha256: string }[] = [];
  const fetchFile = async (path: string): Promise<void> => {
    const file = join(dir, path);
    const expected = published.get(path);
    if (expected !== undefined && reuse !== null && (await reuseFile(join(reuse, path), file, expected))) {
      entries.push({ path, sha256: expected });
      lfs.push(path);
      return;
    }
    if (reuse !== null) await rm(join(reuse, path), { force: true });
    await net().download(`https://huggingface.co/${pin.source}/resolve/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`, file, headers);
    const sha256 = await sha256File(file);
    if (expected !== undefined && sha256 !== expected) {
      throw new InstallFailure(`hf ${pin.source} file ${path} SHA-256 differs from the published one`, [{ what: `${pin.source} ${path}`, path: file, expected, actual: sha256 }]);
    }
    entries.push({ path, sha256 });
    if (expected !== undefined) lfs.push(path);
  };
  for (const path of small) await fetchFile(path);
  if (pin.sha256 !== undefined && large.length > 0) {
    const expected = hfDigest([...entries, ...large.map((p) => ({ path: p, sha256: published.get(p) as string }))]);
    if (expected !== pin.sha256) {
      throw new InstallFailure(`hf ${pin.source} SHA-256 differs (checked with the published SHA-256 of its LFS files, before downloading them)`, [{ what: pin.source, path: dir, expected: pin.sha256, actual: expected }]);
    }
  }
  for (const path of large) await fetchFile(path);
  return entries;
}

async function installHf(pin: GenerationPin, dir: string, token: string | null, reuse: string | null, lfs: string[]): Promise<MethodMarker['hf'][number]> {
  if (pin.revision === undefined) throw new InstallFailure(`hf pin ${pin.source} has no revision`);
  const headers = token === null ? undefined : { Authorization: `Bearer ${token}` };
  const info = await hfInfo(pin, pin.revision, headers);
  if (info.sha !== pin.revision) {
    throw new InstallFailure(`hf ${pin.source} revision differs`, [{ what: pin.source, path: dir, expected: pin.revision, actual: info.sha ?? '' }]);
  }
  // An hf pin without `files` gets the whole repository (harness settings schema `pin.files`).
  const include = pin.files === undefined ? ['*'] : patterns(pin.files);
  const exclude = patterns(pin.exclude);
  const wanted = (info.siblings ?? [])
    .map((s) => s.rfilename)
    .filter((p) => include.some((g) => globMatch(g, p)) && !exclude.some((g) => globMatch(g, p)));
  if (wanted.length === 0) {
    throw new InstallFailure(`hf ${pin.source} has no file that matches files ${pin.files ?? '*'}${pin.exclude === undefined ? '' : ` without exclude ${pin.exclude}`}`);
  }
  const entries = await downloadHfFiles(pin, pin.revision, dir, headers, wanted, info, reuse, lfs);
  const actual = hfDigest(entries);
  if (pin.sha256 !== undefined && actual !== pin.sha256) {
    throw new InstallFailure(`hf ${pin.source} SHA-256 differs`, [{ what: pin.source, path: dir, expected: pin.sha256, actual }]);
  }
  return { source: pin.source, dir, sha256: actual };
}

async function installFilePin(pin: GenerationPin, dir: string): Promise<void> {
  if (pin.url === undefined) throw new InstallFailure(`file pin ${pin.source} has no url`);
  const file = join(dir, pin.files ?? pin.source);
  await net().download(pin.url, file);
  const actual = await sha256File(file);
  if (pin.sha256 !== undefined && actual !== pin.sha256) {
    throw new InstallFailure(`file ${pin.source} SHA-256 differs`, [{ what: pin.source, path: file, expected: pin.sha256, actual }]);
  }
}

/** The single `[project.scripts]` entry name of a `pyproject.toml`. */
export function projectScript(pyproject: string): string {
  const section = /^\[project\.scripts\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(pyproject)?.[1] ?? '';
  const names = [...section.matchAll(/^\s*["']?([A-Za-z0-9_.-]+)["']?\s*=/gm)].map((m) => m[1] as string);
  if (names.length !== 1) throw new InstallFailure(`pyproject.toml must have one [project.scripts] entry, found ${String(names.length)}`);
  return names[0] as string;
}

function venvBin(venv: string, program: string): string {
  return venvProgram(venv, program, process.platform === 'win32');
}

async function makeVenv(ctx: Context, dir: string): Promise<{ venv: string; python: string }> {
  const venv = join(dir, 'venv');
  await runOk('uv', ['venv', '--quiet', venv], { env: ctx.env, timeoutMs: LIMITS.programMs });
  return { venv, python: venvBin(venv, 'python') };
}

/**
 * The text of the provider `cli`: puts `ffmpegDir` on PATH and runs `target` with the arguments. Paths are quoted
 * for the shell: `'` becomes `'\''` in sh, `%` becomes `%%` in a `.cmd` file (a Windows path has no `"`).
 */
export function cliWrapper(ffmpegDir: string, target: string, windows: boolean): string {
  if (windows) {
    const cmd = (text: string): string => text.replaceAll('%', '%%');
    return `@echo off\r\nset "PATH=${cmd(ffmpegDir)};%PATH%"\r\n"${cmd(target)}" %*\r\n`;
  }
  const sh = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;
  return `#!/bin/sh\nPATH=${sh(ffmpegDir)}:"$PATH"\nexport PATH\nexec ${sh(target)} "$@"\n`;
}

async function providerCli(ctx: Context, dir: string, gitDir: string, venv: string): Promise<{ cli: string; skill: string; ffmpeg: string }> {
  const ffmpeg = await toolProgram(ctx, 'ffmpeg');
  if (ffmpeg === null) throw new InstallFailure('tools.ffmpeg is not installed');
  const script = projectScript(await readFile(join(gitDir, 'pyproject.toml'), 'utf8').catch(() => ''));
  const skill = exists(join(gitDir, 'SKILL.md')) ? join(gitDir, 'SKILL.md') : await findFile(gitDir, (name, rel) => name === 'SKILL.md' && !rel.startsWith('.git/'));
  if (skill === null) throw new InstallFailure('SKILL.md not found in the git repository');
  const ffmpegDir = join(ffmpeg, '..');
  const target = venvBin(venv, script);
  const cli = join(dir, 'bin', process.platform === 'win32' ? `${script}.cmd` : script);
  await writeFileAtomic(cli, cliWrapper(ffmpegDir, target, process.platform === 'win32'));
  await chmod(cli, 0o755);
  return { cli, skill, ffmpeg };
}

interface Downloaded {
  git: MethodMarker['git'];
  hf: MethodMarker['hf'];
  pip: string[];
  files: string | null;
}

/** `reuse`: the `.reuse` folder of each hf pin index. `lfs` receives, by hf pin index, the checked LFS files in place. */
async function downloadPins(ctx: Context, method: GenerationMethod, dir: string, reuse: ReadonlyMap<number, string>, lfs: Map<number, string[]>): Promise<Downloaded> {
  const got: Downloaded = { git: [], hf: [], pip: [], files: null };
  for (const [index, pin] of (method.pins ?? []).entries()) {
    if (pin.kind === 'git') got.git.push(await installGit(pin, join(dir, 'git', String(index)), ctx.env));
    else if (pin.kind === 'patch') await applyPatch(ctx, pin, got.git.at(-1)?.dir);
    else if (pin.kind === 'hf') {
      const token = pin.secret === undefined ? null : ctx.secrets.get(harnessSecretService(pin.secret));
      const checked: string[] = [];
      lfs.set(index, checked);
      got.hf.push(await installHf(pin, join(dir, 'hf', String(index)), token, reuse.get(index) ?? null, checked));
    }
    else if (pin.kind === 'pip') got.pip.push(...pipRequirements(pin.source));
    else {
      got.files = join(dir, 'files');
      await installFilePin(pin, got.files);
    }
  }
  return got;
}

async function installDownloaded(ctx: Context, method: GenerationMethod, dir: string, got: Downloaded): Promise<MethodMarker> {
  const marker: MethodMarker = { name: method.name, pins: JSON.stringify(method.pins ?? []), git: got.git, hf: got.hf, files: got.files, python: null, cli: null, skill: null };
  const options = { env: ctx.env, timeoutMs: LIMITS.programMs };
  if (method.provider !== undefined) {
    const gitDir = got.git[0]?.dir;
    if (gitDir === undefined) throw new InstallFailure('a provider method needs a git pin');
    const { venv, python } = await makeVenv(ctx, dir);
    await runOk('uv', ['pip', 'install', '--quiet', '--no-deps', '--python', python, gitDir, ...got.pip], options);
    return { ...marker, python, ...(await providerCli(ctx, dir, gitDir, venv)) };
  }
  // A local-model call runs its git checkout from PYTHONPATH with the method's Python (`tools/ogw.md` `## generation call`).
  if (got.pip.length > 0 || (method.kind === 'local-model' && got.git.length > 0)) {
    const { python } = await makeVenv(ctx, dir);
    if (got.pip.length > 0) await runOk('uv', ['pip', 'install', '--quiet', '--python', python, ...got.pip], options);
    return { ...marker, python };
  }
  return marker;
}

/**
 * Installs the pins of one method into `.ogw/generation/<method>/` under the lock of the method folder. Reuses the
 * LFS files of the hf pins of the previous install, or of the hf files a failed install kept, with the same `source`
 * and `revision` (`keepHfFolders`). When it fails, keeps only the downloaded hf files (`keepHfFiles`).
 */
export function installMethod(ctx: Context, method: GenerationMethod): Promise<InstallEntry> {
  return withMethodLock(ctx, method.name, () => installMethodLocked(ctx, method));
}

async function installMethodLocked(ctx: Context, method: GenerationMethod): Promise<InstallEntry> {
  if (await methodMarker(ctx, method)) return { installed: true, reason: null, mismatches: [] };
  const unpinned = (method.pins ?? []).find((p) => p.kind === 'git' && p.revision === undefined);
  if (unpinned) return { installed: false, reason: `git pin ${unpinned.source} has no revision`, mismatches: [] };
  const locked = missingPinSecret(ctx, method);
  if (locked) return { installed: false, reason: `harness secret ${String(locked.secret)} of hf pin ${locked.source} is not in the host secret store: ${pinSecretAction(locked)}`, mismatches: [] };
  const dir = await methodDir(ctx, method.name);
  const pins = method.pins ?? [];
  const reuse = await keepHfFolders(dir, pins);
  const lfs = new Map<number, string[]>();
  return refillFolder(
    dir,
    async () => {
      const marker = await installDownloaded(ctx, method, dir, await downloadPins(ctx, method, dir, reuse, lfs));
      await rm(join(dir, REUSE), { recursive: true, force: true });
      return marker;
    },
    REUSE,
    () => keepHfFiles(dir, pins, lfs),
  );
}

/**
 * Folder in the method folder that holds hf files for the next install: the folder `<pin index>` of each hf pin, and
 * `pins.json` (`{ pins }` as in the marker) naming the pins those indexes are of.
 */
const REUSE = '.reuse';
const REUSE_PINS = 'pins.json';

/** Each hf pin with a revision and its folder `<parent>/<pin index>`. */
function hfFolders(pins: readonly GenerationPin[], parent: string): { pin: GenerationPin; dir: string }[] {
  return pins.flatMap((pin, index) => (pin.kind === 'hf' && pin.revision !== undefined ? [{ pin, dir: join(parent, String(index)) }] : []));
}

/**
 * Removes the marker of the previous install and moves to `.reuse/<pin index>` the hf folder of each hf pin whose
 * `source` and `revision` an hf pin of the previous install, or of the `.reuse` folder a failed install kept, had.
 * Returns those folders by pin index.
 */
async function keepHfFolders(dir: string, pins: readonly GenerationPin[]): Promise<Map<number, string>> {
  const reuse = new Map<number, string>();
  const keep = join(dir, REUSE);
  const next = join(dir, `${REUSE}.next`);
  await rm(next, { recursive: true, force: true });
  const previous = await readJsonIfExists<MethodMarker>(join(dir, 'installed.json')).catch(() => null);
  await rm(join(dir, 'installed.json'), { force: true });
  const kept = await readJsonIfExists<{ pins?: unknown }>(join(keep, REUSE_PINS)).catch(() => null);
  const old = [...hfFolders(previousPinsOf(previous), join(dir, 'hf')), ...hfFolders(previousPinsOf(kept), keep)];
  for (const [index, pin] of pins.entries()) {
    if (pin.kind !== 'hf') continue;
    const match = old.findIndex((o) => o.pin.source === pin.source && o.pin.revision === pin.revision && exists(o.dir));
    if (match === -1) continue;
    const from = (old.splice(match, 1)[0] as (typeof old)[number]).dir;
    await mkdir(next, { recursive: true });
    await rename(from, join(next, String(index)));
    reuse.set(index, join(keep, String(index)));
  }
  await rm(keep, { recursive: true, force: true });
  if (reuse.size > 0) {
    await rename(next, keep);
    await writeJsonAtomic(join(keep, REUSE_PINS), { pins: JSON.stringify(pins) });
  }
  return reuse;
}

/**
 * After a failed install: moves the checked LFS files each hf pin got (`lfs`, by pin index) into `.reuse/<pin index>`,
 * next to the files of `.reuse` the install did not take, so the next install reuses them. True when `.reuse` holds a
 * pin folder.
 */
async function keepHfFiles(dir: string, pins: readonly GenerationPin[], lfs: ReadonlyMap<number, readonly string[]>): Promise<boolean> {
  const keep = join(dir, REUSE);
  for (const [index, paths] of lfs) {
    for (const path of paths) {
      const to = join(keep, String(index), path);
      await mkdir(dirname(to), { recursive: true });
      await rename(join(dir, 'hf', String(index), path), to);
    }
  }
  if ((await readdir(keep).catch(() => [])).every((name) => name === REUSE_PINS)) return false;
  await writeJsonAtomic(join(keep, REUSE_PINS), { pins: JSON.stringify(pins) });
  return true;
}

function previousPinsOf(marker: { pins?: unknown } | null): GenerationPin[] {
  if (marker === null || typeof marker.pins !== 'string') return [];
  try {
    const pins = JSON.parse(marker.pins) as unknown;
    return Array.isArray(pins) ? (pins as GenerationPin[]) : [];
  } catch {
    return [];
  }
}

/** The harness secret of an external-service method without `provider`, when it is missing from the host secret store. */
export function missingSecret(ctx: Context, method: GenerationMethod): string | null {
  if (method.kind !== 'external-service' || method.provider !== undefined || method.secret === undefined) return null;
  return ctx.secrets.get(harnessSecretService(method.secret)) === null ? method.secret : null;
}

/** The first hf pin of the method whose `secret` is missing from the host secret store. */
export function missingPinSecret(ctx: Context, method: GenerationMethod): GenerationPin | null {
  return (method.pins ?? []).find((p) => p.kind === 'hf' && p.secret !== undefined && ctx.secrets.get(harnessSecretService(p.secret)) === null) ?? null;
}
