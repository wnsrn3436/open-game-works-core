import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { LIMITS } from '../../../lib/limits.ts';
import { run } from '../../../lib/proc.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';
import { packageFolders, type CheckTarget } from './target.ts';

/** Vulnerable packages of `npm audit --json` at `high` or `critical`. */
export function auditFailures(json: string): string[] | null {
  try {
    const report = JSON.parse(json) as { vulnerabilities?: Record<string, { severity?: string }> };
    return Object.entries(report.vulnerabilities ?? {})
      .filter(([, v]) => v.severity === 'high' || v.severity === 'critical')
      .map(([name, v]) => `${name} ${String(v.severity)}`);
  } catch {
    return null;
  }
}

function label(folder: string): string {
  return folder === '' ? '.' : folder;
}

/** Copies the package folder's files (without nested packages) into a new folder in the temp folder of ogw. */
async function copyPackage(target: CheckTarget, folder: string, nested: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  const copy = await newPrivateTempFolder('ogw-npm-', env);
  const prefix = folder === '' ? '' : `${folder}/`;
  for (const path of target.files) {
    if (!path.startsWith(prefix) || nested.some((n) => n !== folder && path.startsWith(`${n}/`) && n.startsWith(prefix))) continue;
    const to = join(copy, path.slice(prefix.length));
    await mkdir(dirname(to), { recursive: true });
    await copyFile(join(target.root, path), to);
  }
  return copy;
}

async function checkPackage(target: CheckTarget, folder: string, folders: readonly string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  const name = label(folder);
  if (!target.files.includes(posix.join(folder, 'package-lock.json'))) return [`${name}: package-lock.json is missing`];
  const copy = await copyPackage(target, folder, folders, env);
  try {
    // the audit runs on its own below
    const ci = await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: copy, env, timeoutMs: LIMITS.programMs });
    if (ci.code !== 0) return [`${name}: npm ci failed: ${(ci.stderr || ci.stdout).trim().split('\n').slice(-5).join(' ')}`];
    const audit = await run('npm', ['audit', '--audit-level=high', '--json'], { cwd: copy, env, timeoutMs: LIMITS.programMs });
    if (audit.code === 0) return [];
    const vulnerable = auditFailures(audit.stdout);
    if (vulnerable === null || vulnerable.length === 0) return [`${name}: npm audit failed: ${(audit.stderr || audit.stdout).trim()}`];
    return vulnerable.map((v) => `${name}: npm audit: ${v}`);
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

/** Every folder with a `package.json` has a `package-lock.json`, `npm ci` succeeds, and `npm audit --audit-level=high` passes. */
export async function dependencyCheck(target: CheckTarget, env: NodeJS.ProcessEnv): Promise<string[]> {
  const folders = packageFolders(target.files);
  const results = await Promise.all(folders.map((folder) => checkPackage(target, folder, folders, env)));
  return results.flat();
}
