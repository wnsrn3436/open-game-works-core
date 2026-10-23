import { join, relative, resolve } from 'node:path';
import { ESLint } from 'eslint';
import { writeJsonAtomic } from '../../../lib/fsx.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { run } from '../../../lib/proc.ts';
import { typescriptLintConfig } from '../eslint-options.ts';
import { typescriptCompilerOptions } from '../ts-options.ts';
import { ogwRequire, ogwTools, isBenchmarkPath, isTypeDeclaration, isTypeScript, type CheckTarget } from './target.ts';

/** The vitest global types that server core tests use (`testing` `### test run`). */
export function vitestGlobals(): string {
  return join(ogwTools(), 'node_modules', 'vitest', 'globals.d.ts');
}

/**
 * The files of the target the TypeScript type check and lint read: all but the benchmark games of `open-game-works-core-impl/`
 * (`benchmark/`), game repos whose server code compiles only with the server core of a core release.
 */
function typeScriptFiles(target: CheckTarget): string[] {
  return target.side === 'core' ? target.files.filter((path) => !isBenchmarkPath(path)) : [...target.files];
}

/** Writes the tsconfig of the check into `folder` and returns its path; null when the target has no TypeScript. */
export async function writeTsconfig(target: CheckTarget, folder: string): Promise<string | null> {
  const checked = typeScriptFiles(target);
  const sources = checked.filter(isTypeScript);
  if (sources.length === 0) return null;
  // Declaration files are in `files` too: with no `include`, tsc loads an ambient declaration only when it is listed.
  const files = [...sources, ...checked.filter(isTypeDeclaration)].map((path) => join(target.root, path));
  if (target.side === 'core' && target.files.some((path) => path.startsWith('server/core/') && path.endsWith('.test.ts'))) files.push(vitestGlobals());
  const path = join(folder, 'tsconfig.json');
  await writeJsonAtomic(path, {
    compilerOptions: typescriptCompilerOptions(),
    files,
  });
  return path;
}

const TSC_ERROR = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/** `tsc` output lines as `file:line:column TSxxxx message`, files relative to the target. */
export function tscFailures(output: string, root: string): string[] {
  const failures: string[] = [];
  for (const line of output.split('\n')) {
    const match = TSC_ERROR.exec(line.trim());
    if (match) failures.push(`${relative(root, resolve(root, match[1] as string))}:${match[2] as string}:${match[3] as string} ${match[4] as string} ${match[5] as string}`);
  }
  return failures;
}

export async function typeCheckTypeScript(target: CheckTarget, tsconfig: string | null): Promise<string[]> {
  if (tsconfig === null) return [];
  const tsc = join(ogwRequire().resolve('typescript/package.json'), '..', 'bin', 'tsc');
  const result = await run(process.execPath, [tsc, '-p', tsconfig, '--pretty', 'false'], { cwd: target.root, timeoutMs: LIMITS.programMs });
  if (result.code === 0 && !result.timedOut) return [];
  const failures = tscFailures(result.stdout + result.stderr, target.root);
  return failures.length > 0 ? failures : [`tsc: ${(result.stdout + result.stderr).trim() || `exit code ${String(result.code)}`}`];
}

export async function lintTypeScript(target: CheckTarget, tsconfig: string | null, maxComplexity: number): Promise<string[]> {
  if (tsconfig === null) return [];
  const eslint = new ESLint({
    cwd: target.root,
    overrideConfigFile: true,
    overrideConfig: typescriptLintConfig(target.root, maxComplexity, tsconfig),
  });
  const files = typeScriptFiles(target).filter(isTypeScript).map((path) => join(target.root, path));
  const results = await eslint.lintFiles(files);
  return results.flatMap((result) =>
    result.messages
      .filter((message) => message.severity === 2)
      .map((message) => `${relative(target.root, result.filePath)}:${String(message.line)}:${String(message.column)} ${message.ruleId ?? 'error'} ${message.message}`),
  );
}
