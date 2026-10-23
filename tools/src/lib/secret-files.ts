import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { OgwError } from './errors.ts';
import { harnessRoot } from './paths.ts';

/**
 * The git common dir of checkout `root` (what `git rev-parse --git-common-dir` names), read from its `.git` without
 * running git, so that it holds where git is missing (`ogw env check` reports that) or is another program.
 */
async function checkoutCommonDir(root: string): Promise<string> {
  const dotGit = join(root, '.git');
  const info = await stat(dotGit).catch(() => null);
  if (info === null) throw new OgwError(`the harness repo ${root} is not a git checkout`);
  if (info.isDirectory()) return dotGit;
  const gitDir = /^gitdir: (.+)$/m.exec(await readFile(dotGit, 'utf8'))?.[1]?.trim();
  if (gitDir === undefined) throw new OgwError(`${dotGit} names no gitdir`);
  const absolute = resolve(root, gitDir);
  const common = await readFile(join(absolute, 'commondir'), 'utf8').catch(() => null);
  return common === null ? absolute : resolve(absolute, common.trim());
}

/** Folder `name` in the harness repo's git common dir, which the play and judge sandbox and the broker sandbox block (ogw.md `## agent`). */
async function harnessGitFolder(name: string, env: NodeJS.ProcessEnv): Promise<string> {
  return join(await checkoutCommonDir(harnessRoot(env)), name);
}

/** Makes `dir` owner-only (0700) and returns its path. */
async function ownerDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

/** A new empty folder in `dir` (made 0700) that only the owner can enter (0700), as a real path. */
async function newOwnerFolder(dir: string, prefix: string): Promise<string> {
  const folder = realpathSync(await mkdtemp(join(await ownerDir(dir), prefix)));
  await chmod(folder, 0o700);
  return folder;
}

/**
 * Folder of the files that hold secret values while a command uses them (signing material, the deploy SSH key):
 * `ogw-secret-files/` in the harness repo's git common dir (ogw.md `## secret in command line`).
 */
export async function secretFilesDir(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return harnessGitFolder('ogw-secret-files', env);
}

/** A new empty folder that only the owner can enter (0700) in `secretFilesDir`. The caller removes it after use. */
export async function newSecretFolder(prefix: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return newOwnerFolder(await secretFilesDir(env), prefix);
}

/** Folder of the temporary folders and files of `ogw`: `ogw-temp/` in the harness repo's git common dir (ogw.md `## temp folder`). */
export async function privateTempDir(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return harnessGitFolder('ogw-temp', env);
}

/** A new empty folder that only the owner can enter (0700) in `privateTempDir`, as a real path. The caller removes it after use. */
export async function newPrivateTempFolder(prefix: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return newOwnerFolder(await privateTempDir(env), prefix);
}

/** The path of file `name` in folder `folder` of `privateTempDir`, both made 0700, for a temporary file that stays between commands. */
export async function privateTempPath(folder: string, name: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  await ownerDir(await privateTempDir(env));
  return join(await ownerDir(join(await privateTempDir(env), folder)), name);
}
