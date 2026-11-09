import { chmod, copyFile, link, mkdir, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { exists, isNotFound, readJsonIfExists, whenNotFound, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
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

/** `installed.json` of the install folder of a generation method, written last. */
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
}

/** The real path of `path`: of its deepest existing folder, with the rest of the path after it. */
async function realPathOf(path: string): Promise<string> {
  const real = await realpath(path).catch(whenNotFound(null));
  if (real !== null) return real;
  const parent = dirname(path);
  return parent === path ? path : join(await realPathOf(parent), basename(path));
}

/**
 * `.ogw/generation-install/` of the workspace root by its real path, which holds the install folders (ogw.md `## generation
 * install`): not `.ogw/generation/`, whose method folders the install of a harness before the install keys empties.
 */
async function installRoot(ctx: Context): Promise<string> {
  return realPathOf(join(await dataDir(ctx), 'generation-install'));
}

/** `.ogw/generation/<method>/` of the workspace root by its real path: the folder of the installs of a harness before the install folders of `installRoot`. */
async function olderMethodFolder(ctx: Context, method: GenerationMethod): Promise<string> {
  return realPathOf(join(await dataDir(ctx), 'generation', safeSegment(method.name)));
}

/** The `tools.ffmpeg` program a method's `cli` puts on PATH, by its real path: for a method with `provider`, else null. */
async function cliFfmpeg(ctx: Context, method: GenerationMethod): Promise<string | null> {
  if (method.provider === undefined) return null;
  const program = await toolProgram(ctx, 'ffmpeg');
  return program === null ? null : realPathOf(program);
}

/** The pins with the `sha256` of each hf pin left out: an hf `sha256` checks the files, it does not choose them. */
function withoutHfSha256(pins: readonly GenerationPin[]): GenerationPin[] {
  return pins.map((pin) => {
    if (pin.kind !== 'hf' || pin.sha256 === undefined) return pin;
    const rest: GenerationPin = { ...pin };
    delete rest.sha256;
    return rest;
  });
}

/** The install key of a method on this checkout (ogw.md `## generation install`). */
export async function installKey(ctx: Context, method: GenerationMethod): Promise<string> {
  const identity = JSON.stringify({ pins: withoutHfSha256(method.pins ?? []), ffmpeg: await cliFfmpeg(ctx, method) });
  return sha256Text(identity).slice(0, 16);
}

/** The install folder of a method on this checkout: `.ogw/generation-install/<method>/<install key>/` by its real path. */
export async function methodDir(ctx: Context, method: GenerationMethod): Promise<string> {
  return join(await installRoot(ctx), safeSegment(method.name), await installKey(ctx, method));
}

/** Each hf pin of `pins` with a `sha256` that differs from the SHA-256 of the files of that pin the install of `marker` got. */
function hfDigestMismatches(marker: MethodMarker, pins: readonly GenerationPin[]): { pin: GenerationPin; digest: string | undefined; dir: string | undefined }[] {
  let hf = 0;
  return pins.flatMap((pin) => {
    if (pin.kind !== 'hf') return [];
    const got = marker.hf[hf++];
    return pin.sha256 !== undefined && pin.sha256 !== got?.sha256 ? [{ pin, digest: got?.sha256, dir: got?.dir }] : [];
  });
}

/**
 * True when the marker was installed from these pins: the pins are the same with every hf `sha256` left out, and each hf
 * `sha256` of these pins is the SHA-256 of the files the install got. So an hf `sha256` added after the install, as the
 * `sha256:<method>` proposal adds it, keeps the install.
 */
export function installedFrom(marker: MethodMarker, pins: readonly GenerationPin[]): boolean {
  if (typeof marker.pins !== 'string') return false;
  // `pins` of a marker is the JSON the install wrote: a marker whose pins are not JSON is thrown
  const pinned: unknown = JSON.parse(marker.pins);
  if (!Array.isArray(pinned) || JSON.stringify(withoutHfSha256(pinned as GenerationPin[])) !== JSON.stringify(withoutHfSha256(pins))) return false;
  return hfDigestMismatches(marker, pins).length === 0;
}

/** The method's install marker, when its install folder on this checkout holds an install of its current pins. */
export async function methodMarker(ctx: Context, method: GenerationMethod): Promise<MethodMarker | null> {
  const marker = await readJsonIfExists<MethodMarker>(join(await methodDir(ctx, method), 'installed.json'));
  if (!marker || marker.name !== method.name || !installedFrom(marker, method.pins ?? [])) return null;
  return marker;
}

/**
 * Runs `fn` under the lock of the method's install folder. `generation install` holds it while it empties and refills
 * the folder; `generation run` and `generation measure` hold it while a call uses the folder.
 */
export async function withMethodLock<T>(ctx: Context, method: GenerationMethod, fn: () => Promise<T>): Promise<T> {
  return withLock(installLockPath(await methodDir(ctx, method)), fn, LIMITS.jobMs);
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
 * Puts at `to` the file `from` of another install when its SHA-256 is `expected`: a hard link, or a copy when no hard
 * link can be made. The other install keeps its file. The other install is not under the lock of this install folder,
 * so its file can be removed or replaced meanwhile: a `from` that is gone (`ENOENT`) is not put, and the SHA-256 is read
 * from the file put at `to`, which is removed when it differs. True when put.
 */
async function linkFile(from: string, to: string, expected: string): Promise<boolean> {
  await mkdir(dirname(to), { recursive: true });
  await rm(to, { force: true });
  const put = await link(from, to).then(
    () => true,
    (error: unknown) => {
      if (isNotFound(error)) return false;
      if (!NO_HARD_LINK.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      return copyFile(from, to).then(() => true, whenNotFound(false));
    },
  );
  if (!put) return false;
  if ((await sha256File(to)) === expected) return true;
  await rm(to, { force: true });
  return false;
}

/** The `link` errors that say no hard link of the file can be made there (another file system, or one without hard links). */
const NO_HARD_LINK: ReadonlySet<string> = new Set(['EXDEV', 'EPERM', 'EMLINK', 'ENOTSUP', 'EOPNOTSUPP']);

/**
 * Downloads the wanted files of an hf pin. Files without an LFS SHA-256 (small text files) come first, so a pin whose
 * SHA-256 cannot match fails before any large file is downloaded; each LFS file is checked against its published
 * SHA-256 as soon as it arrives. An LFS file whose SHA-256 is the published one is taken instead of downloaded: from
 * the folder `reuse.kept` (moved; its other files at the paths of wanted files are removed), else from a folder of
 * `reuse.others` (linked). `lfs` receives the path of each LFS file in place whose SHA-256 is the published one.
 */
async function downloadHfFiles(
  pin: GenerationPin,
  revision: string,
  dir: string,
  headers: Record<string, string> | undefined,
  wanted: readonly string[],
  info: HfInfo,
  reuse: HfReuse,
  lfs: string[],
): Promise<{ path: string; sha256: string }[]> {
  const published = new Map((info.siblings ?? []).flatMap((s) => (s.lfs?.sha256 === undefined ? [] : [[s.rfilename, s.lfs.sha256] as const])));
  const small = wanted.filter((p) => !published.has(p));
  const large = wanted.filter((p) => published.has(p));
  const entries: { path: string; sha256: string }[] = [];
  const fetchFile = async (path: string): Promise<void> => {
    const file = join(dir, path);
    const expected = published.get(path);
    if (expected !== undefined && (await takeReused(reuse, path, file, expected))) {
      entries.push({ path, sha256: expected });
      lfs.push(path);
      return;
    }
    if (reuse.kept !== null) await rm(join(reuse.kept, path), { force: true });
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

/**
 * Where an install takes the LFS files of an hf pin from instead of downloading them: `kept`, the `.reuse/<pin index>`
 * folder a failed install of the same install folder kept (moved), and `others`, the folders of that pin of other installs
 * of the method (linked).
 */
interface HfReuse {
  kept: string | null;
  others: readonly string[];
}

async function takeReused(reuse: HfReuse, path: string, to: string, expected: string): Promise<boolean> {
  if (reuse.kept !== null && (await reuseFile(join(reuse.kept, path), to, expected))) return true;
  for (const folder of reuse.others) if (await linkFile(join(folder, path), to, expected)) return true;
  return false;
}

async function installHf(pin: GenerationPin, dir: string, token: string | null, reuse: HfReuse, lfs: string[]): Promise<MethodMarker['hf'][number]> {
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

async function providerCli(ctx: Context, method: GenerationMethod, dir: string, gitDir: string, venv: string): Promise<{ cli: string; skill: string }> {
  const ffmpeg = await cliFfmpeg(ctx, method);
  if (ffmpeg === null) throw new InstallFailure('tools.ffmpeg is not installed');
  const script = projectScript(await readFile(join(gitDir, 'pyproject.toml'), 'utf8').catch(whenNotFound('')));
  const skill = exists(join(gitDir, 'SKILL.md')) ? join(gitDir, 'SKILL.md') : await findFile(gitDir, (name, rel) => name === 'SKILL.md' && !rel.startsWith('.git/'));
  if (skill === null) throw new InstallFailure('SKILL.md not found in the git repository');
  const ffmpegDir = join(ffmpeg, '..');
  const target = venvBin(venv, script);
  const cli = join(dir, 'bin', process.platform === 'win32' ? `${script}.cmd` : script);
  await writeFileAtomic(cli, cliWrapper(ffmpegDir, target, process.platform === 'win32'));
  await chmod(cli, 0o755);
  return { cli, skill };
}

interface Downloaded {
  git: MethodMarker['git'];
  hf: MethodMarker['hf'];
  pip: string[];
  files: string | null;
}

/**
 * `reuse`: the `.reuse` folder of each hf pin index; `others`: the folders of each hf pin index in other installs of the
 * method. `lfs` receives, by hf pin index, the checked LFS files in place.
 */
async function downloadPins(
  ctx: Context,
  method: GenerationMethod,
  dir: string,
  reuse: ReadonlyMap<number, string>,
  others: ReadonlyMap<number, readonly string[]>,
  lfs: Map<number, string[]>,
): Promise<Downloaded> {
  const got: Downloaded = { git: [], hf: [], pip: [], files: null };
  for (const [index, pin] of (method.pins ?? []).entries()) {
    if (pin.kind === 'git') got.git.push(await installGit(pin, join(dir, 'git', String(index)), ctx.env));
    else if (pin.kind === 'patch') await applyPatch(ctx, pin, got.git.at(-1)?.dir);
    else if (pin.kind === 'hf') {
      const token = pin.secret === undefined ? null : ctx.secrets.get(harnessSecretService(pin.secret));
      const checked: string[] = [];
      lfs.set(index, checked);
      got.hf.push(await installHf(pin, join(dir, 'hf', String(index)), token, { kept: reuse.get(index) ?? null, others: others.get(index) ?? [] }, checked));
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
    return { ...marker, python, ...(await providerCli(ctx, method, dir, gitDir, venv)) };
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
 * Installs the pins of one method into its install folder (`methodDir`) under the lock of that folder. Reuses the LFS
 * files of the hf pins with the same `source` and `revision`: of the previous install of the folder or of the hf files
 * a failed install kept (`keepHfFolders`), and of other installs of the method (`otherInstallHf`). When it fails, keeps
 * only the downloaded hf files (`keepHfFiles`).
 */
export function installMethod(ctx: Context, method: GenerationMethod): Promise<InstallEntry> {
  return withMethodLock(ctx, method, () => installMethodLocked(ctx, method));
}

/**
 * The failure of an install into a folder whose install got hf files with another SHA-256 than the pinned one: that
 * install is kept as it is (ogw.md `## generation install`). Null when the folder holds no such install.
 */
async function digestConflict(dir: string, pins: readonly GenerationPin[]): Promise<InstallEntry | null> {
  const marker = await readJsonIfExists<MethodMarker>(join(dir, 'installed.json'));
  if (marker === null || !Array.isArray(marker.hf)) return null;
  const pinned = previousPinsOf(marker);
  if (JSON.stringify(withoutHfSha256(pinned)) !== JSON.stringify(withoutHfSha256(pins))) return null;
  const differs = hfDigestMismatches(marker, pins);
  if (differs.length === 0) return null;
  const mismatches = differs.map((d) => ({ what: d.pin.source, path: d.dir ?? dir, expected: d.pin.sha256 as string, actual: d.digest ?? '' }));
  const named = differs.map((d) => `hf ${d.pin.source} sha256 ${String(d.pin.sha256)}, installed ${d.digest ?? 'none'}`).join('; ');
  return { installed: false, reason: `${dir} holds an install whose hf files have another SHA-256 than the pin (${named}); it is kept as it is`, mismatches };
}

async function installMethodLocked(ctx: Context, method: GenerationMethod): Promise<InstallEntry> {
  if (await methodMarker(ctx, method)) return { installed: true, reason: null, mismatches: [] };
  const unpinned = (method.pins ?? []).find((p) => p.kind === 'git' && p.revision === undefined);
  if (unpinned) return { installed: false, reason: `git pin ${unpinned.source} has no revision`, mismatches: [] };
  const locked = missingPinSecret(ctx, method);
  if (locked) return { installed: false, reason: `harness secret ${String(locked.secret)} of hf pin ${locked.source} is not in the host secret store: ${pinSecretAction(locked)}`, mismatches: [] };
  const dir = await methodDir(ctx, method);
  const pins = method.pins ?? [];
  const conflict = await digestConflict(dir, pins);
  if (conflict !== null) return conflict;
  const others = await otherInstallHf(ctx, method, dir, pins);
  const reuse = await keepHfFolders(dir, pins);
  const lfs = new Map<number, string[]>();
  return refillFolder(
    dir,
    async () => {
      const marker = await installDownloaded(ctx, method, dir, await downloadPins(ctx, method, dir, reuse, others, lfs));
      await rm(join(dir, REUSE), { recursive: true, force: true });
      return marker;
    },
    REUSE,
    () => keepHfFiles(dir, pins, lfs),
  );
}

/**
 * Folder in the install folder that holds hf files for the next install: the folder `<pin index>` of each hf pin, and
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
  const previous = await readJsonIfExists<MethodMarker>(join(dir, 'installed.json'));
  await rm(join(dir, 'installed.json'), { force: true });
  const kept = await readJsonIfExists<{ pins?: unknown }>(join(keep, REUSE_PINS));
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
  if ((await readdir(keep).catch(whenNotFound([]))).every((name) => name === REUSE_PINS)) return false;
  await writeJsonAtomic(join(keep, REUSE_PINS), { pins: JSON.stringify(pins) });
  return true;
}

/** The folders in `parent` other than `dir`; none when `parent` does not exist. */
async function foldersIn(parent: string, dir: string): Promise<string[]> {
  const entries = await readdir(parent, { withFileTypes: true }).catch(whenNotFound([]));
  return entries.filter((e) => e.isDirectory()).map((e) => join(parent, e.name)).filter((folder) => folder !== dir);
}

/**
 * The hf folders of the other installs of the method that each hf pin of `pins` can take its LFS files from, by pin
 * index: `hf/<i>/` of each folder of `.ogw/generation-install/<method>/` other than the install folder `dir`, of
 * `.ogw/generation/<method>/` and of each folder in it, whose `installed.json` names the method and whose pin `<i>` is an
 * hf pin with the same `source` and `revision`. The folders under `.ogw/generation/` are only read: no install of this
 * harness is there.
 */
async function otherInstallHf(ctx: Context, method: GenerationMethod, dir: string, pins: readonly GenerationPin[]): Promise<Map<number, string[]>> {
  const older = await olderMethodFolder(ctx, method);
  const folders = [...(await foldersIn(dirname(dir), dir)), older, ...(await foldersIn(older, dir))];
  const found = new Map<number, string[]>();
  for (const folder of folders) {
    const marker = await readJsonIfExists<MethodMarker>(join(folder, 'installed.json'));
    if (marker?.name !== method.name) continue;
    const theirs = previousPinsOf(marker);
    for (const [index, pin] of pins.entries()) {
      if (pin.kind !== 'hf' || pin.revision === undefined) continue;
      for (const [i, other] of theirs.entries()) {
        if (other.kind === 'hf' && other.source === pin.source && other.revision === pin.revision) found.set(index, [...(found.get(index) ?? []), join(folder, 'hf', String(i))]);
      }
    }
  }
  return found;
}

function previousPinsOf(marker: { pins?: unknown } | null): GenerationPin[] {
  if (marker === null || typeof marker.pins !== 'string') return [];
  // the JSON the install wrote: pins that are not JSON are thrown
  const pins = JSON.parse(marker.pins) as unknown;
  return Array.isArray(pins) ? (pins as GenerationPin[]) : [];
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
