import { chmod, copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { readJsonIfExists, writeJsonAtomic } from '../../../lib/fsx.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { withLock } from '../../../lib/lock.ts';
import type { ToolDownload } from '../../../lib/settings.ts';
import { downloadChecked, type Mismatch } from './files.ts';
import { hostPlatform } from './host.ts';

/** `installed.json` written last into an install folder; an install folder without it is not installed. */
export interface InstalledMarker {
  name: string;
  version: string;
  /** SHA-256 of every downloaded file, in download order. */
  sha256: string[];
  /** Path of the program relative to the install folder. */
  program: string;
}

export interface InstallResult {
  installed: boolean;
  /** Files that differ from the pins. */
  mismatches: Mismatch[];
  reason: string | null;
}

export interface DownloadedFile {
  download: ToolDownload;
  file: string;
}

export async function readMarker(dir: string): Promise<InstalledMarker | null> {
  return readJsonIfExists<InstalledMarker>(join(dir, 'installed.json'));
}

/** An install failure with the files that differ from their pins. */
export class InstallFailure extends Error {
  readonly mismatches: Mismatch[];
  constructor(message: string, mismatches: Mismatch[] = []) {
    super(message);
    this.mismatches = mismatches;
  }
}

/** Lock of an install folder: a hidden sibling, so that the install folder itself can be emptied. */
export function installLockPath(dir: string): string {
  return join(dirname(dir), `.${basename(dir)}.lock`);
}

export interface InstallItem {
  /** Install folder. */
  dir: string;
  name: string;
  version: string;
  downloads: readonly ToolDownload[];
  /** Failure reason when a download differs from its SHA-256. */
  mismatchReason: string;
  /** Failure reason when `place` finds no program. */
  notFoundReason: string;
  /** Places the checked downloads in `dir` and returns the absolute program path, or null when there is none. */
  place(files: DownloadedFile[]): Promise<string | null>;
}

const INSTALLED: InstallResult = { installed: true, mismatches: [], reason: null };

async function downloadAll(downloads: readonly ToolDownload[], dir: string, mismatchReason: string): Promise<DownloadedFile[]> {
  const files: DownloadedFile[] = [];
  const mismatches: Mismatch[] = [];
  for (const download of downloads) {
    const { file, mismatch } = await downloadChecked(download.url, download.sha256, join(dir, 'download'));
    // The install folder is removed on failure, so the mismatch names the URL, not the removed file.
    if (mismatch) mismatches.push({ ...mismatch, path: download.url });
    files.push({ download, file });
  }
  if (mismatches.length > 0) throw new InstallFailure(mismatchReason, mismatches);
  return files;
}

/**
 * Installs one engine, build tool or harness settings `tools` pin: under a lock of the install folder, skips
 * when `installed.json` has the same SHA-256 list; otherwise empties the folder, downloads and checks every file,
 * places the program and writes `installed.json` last. Leaves no folder on failure.
 */
export function installItem(item: InstallItem): Promise<InstallResult> {
  return withLock(installLockPath(item.dir), () => installLocked(item), LIMITS.jobMs);
}

async function installLocked(item: InstallItem): Promise<InstallResult> {
  const { dir } = item;
  const sha256 = item.downloads.map((d) => d.sha256);
  const current = await readMarker(dir);
  if (current?.sha256.join(',') === sha256.join(',')) return INSTALLED;
  return refillFolder(dir, async (): Promise<InstalledMarker> => {
    const files = await downloadAll(item.downloads, dir, item.mismatchReason);
    const program = await item.place(files);
    if (program === null) throw new InstallFailure(item.notFoundReason);
    return { name: item.name, version: item.version, sha256, program: relative(dir, program) };
  });
}

/**
 * Empties the install folder except its entry `keep`, runs `fill` and writes the marker it returns as `installed.json`
 * last. On failure removes the folder and gives the reason, with the mismatches of an `InstallFailure`; when
 * `keepOnFailure` returns true, the failure keeps the entry `keep` and removes everything else.
 */
export async function refillFolder(dir: string, fill: () => Promise<object>, keep?: string, keepOnFailure?: () => Promise<boolean>): Promise<InstallResult> {
  if (keep === undefined) await rm(dir, { recursive: true, force: true });
  else await removeExcept(dir, keep);
  await mkdir(dir, { recursive: true });
  try {
    await writeJsonAtomic(join(dir, 'installed.json'), await fill());
    return INSTALLED;
  } catch (error) {
    const kept = keep !== undefined && keepOnFailure !== undefined && (await keepOnFailure().catch(() => false));
    if (kept) await removeExcept(dir, keep);
    else await rm(dir, { recursive: true, force: true });
    return { installed: false, mismatches: error instanceof InstallFailure ? error.mismatches : [], reason: (error as Error).message };
  }
}

async function removeExcept(dir: string, keep: string): Promise<void> {
  for (const name of await readdir(dir).catch(() => [])) if (name !== keep) await rm(join(dir, name), { recursive: true, force: true });
}

/** A program of a Python virtual environment: `Scripts/<program>.exe` on Windows, `bin/<program>` elsewhere. */
export function venvProgram(venv: string, program: string, windows: boolean): string {
  return windows ? join(venv, 'Scripts', `${program}.exe`) : join(venv, 'bin', program);
}

/** Makes a downloaded program file runnable: mode 0755, and on Windows a copy named `.exe`. Returns its path. */
export async function makeRunnable(file: string, env: NodeJS.ProcessEnv): Promise<string> {
  await chmod(file, 0o755);
  if (hostPlatform(env) !== 'windows-x64' || file.toLowerCase().endsWith('.exe')) return file;
  await copyFile(file, `${file}.exe`);
  return `${file}.exe`;
}
