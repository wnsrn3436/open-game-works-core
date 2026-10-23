import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { OgwError } from '../../lib/errors.ts';
import { exists, filesUnder, writeFileAtomic } from '../../lib/fsx.ts';
import { commonDir } from '../../lib/git.ts';
import { LIMITS } from '../../lib/limits.ts';
import { harnessRoot } from '../../lib/paths.ts';
import { run } from '../../lib/proc.ts';
import { newPrivateTempFolder } from '../../lib/secret-files.ts';

/**
 * The GDScript type check and lint of `client-core` Godot `## GDScript`, shared by `ogw code check` and static check
 * `type check` and `lint`. Each caller gives its own files.
 */

/** Godot warnings the harness tool writes into `project.godot` as errors (`2`) (`client-core` Godot `## GDScript`). */
export const GDSCRIPT_ERROR_WARNINGS: readonly string[] = [
  'untyped_declaration',
  'inference_on_variant',
  'unsafe_property_access',
  'unsafe_method_access',
  'unsafe_cast',
  'unsafe_call_argument',
];

/** gdlint rules other than the name rules; they are turned off. */
export const GDLINT_OFF_RULES: readonly string[] = [
  'class-definitions-order',
  'comparison-with-itself',
  'duplicated-load',
  'expression-not-assigned',
  'function-arguments-number',
  'max-file-lines',
  'max-line-length',
  'max-public-methods',
  'max-returns',
  'mixed-tabs-and-spaces',
  'no-elif-return',
  'no-else-return',
  'private-method-call',
  'trailing-whitespace',
  'unnecessary-pass',
  'unused-argument',
];

/** The `gdlintrc` that turns off every rule but the name rules. */
export function gdlintConfig(): string {
  return `disable:\n${GDLINT_OFF_RULES.map((r) => `  - ${r}`).join('\n')}\n`;
}

/** One GDScript error at a checkout-relative path and a 1-based line. */
export interface GdError {
  path: string;
  line: number;
  message: string;
}

/** Errors from gdlint output lines `<file>:<line>: Error: <message>`, with paths relative to `root`. */
export function gdlintErrors(output: string, root: string): GdError[] {
  const out: GdError[] = [];
  for (const line of output.split('\n')) {
    const m = /^(.+?):([0-9]+): Error: (.*)$/.exec(line.trim());
    if (!m) continue;
    out.push({ path: relative(root, m[1] as string).split(sep).join('/'), line: Number(m[2]), message: (m[3] as string).trim() });
  }
  return out;
}

/** gdlint with only the name rules on `files` (relative to `root`). Throws when gdlint times out or fails without errors. */
export async function runGdlint(gdlint: string, root: string, files: readonly string[], env: NodeJS.ProcessEnv): Promise<GdError[]> {
  if (files.length === 0) return [];
  const dir = await newPrivateTempFolder('ogw-gdlint-', env);
  try {
    await writeFile(join(dir, 'gdlintrc'), gdlintConfig());
    const r = await run(gdlint, files.map((f) => join(root, f)), { cwd: dir, env, timeoutMs: LIMITS.programMs });
    if (r.timedOut) throw new OgwError('gdlint timed out');
    const found = gdlintErrors(`${r.stdout}\n${r.stderr}`, root);
    if (found.length === 0 && r.code !== 0) throw new OgwError(`gdlint failed: ${(r.stderr || r.stdout).trim()}`);
    return found;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Errors from Godot `--check-only` output for one file at `path`. A `SCRIPT ERROR:` line takes its location from the
 * next line's `(res://<file>:<line>)`, mapped by `repoPathOf`; without one, the first `ERROR:` line or a non-zero exit
 * code is an error at line 1.
 */
export function godotErrors(output: string, path: string, exitCode: number | null, repoPathOf: (res: string) => string | null): GdError[] {
  const lines = output.split('\n');
  const out: GdError[] = [];
  lines.forEach((line, i) => {
    const m = /^\s*SCRIPT ERROR:\s*(.*)$/.exec(line);
    if (!m) return;
    const loc = /\((res:\/\/[^):]+):([0-9]+)\)/.exec(lines[i + 1] ?? '');
    out.push({ path: loc ? (repoPathOf(loc[1] as string) ?? path) : path, line: loc ? Number(loc[2]) : 1, message: (m[1] as string).trim() });
  });
  if (out.length > 0) return out;
  const error = lines.find((l) => /^\s*ERROR:/.test(l));
  if (error !== undefined || exitCode !== 0) out.push({ path, line: 1, message: (error ?? `godot --check-only ended with ${String(exitCode)}`).trim() });
  return out;
}

/**
 * Godot processes of a type check at once. Each one loads the whole project and keeps several CPUs busy, so more of
 * them at once do not check more files per second (measured: 4 and 18 at once both take about 5 CPU seconds a file).
 */
const PARALLEL = 4;

/** `fn` of each item, at most `size` at once; a finished one starts the next, and the results keep the items' order. */
async function inPool<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
  return out;
}

/** A Godot project inside a checkout. */
export interface GodotProject {
  /** Checkout root. */
  root: string;
  /** Project folder relative to the root. */
  folder: string;
  /** Checkout-relative path of a `res://` path, or null when it is not in the checkout. */
  repoPathOf: (res: string) => string | null;
}

/**
 * Godot type check: `godot --headless --path <project> --import`, then `--check-only --script res://<file>` per file
 * (checkout-relative paths inside the project). A failed import is an error at `<project folder>:1`.
 */
export async function godotTypeCheck(godot: string, project: GodotProject, files: readonly string[], env: NodeJS.ProcessEnv, options: { imported?: boolean } = {}): Promise<GdError[]> {
  if (files.length === 0) return [];
  const dir = join(project.root, project.folder);
  const passed = await passedCheckFile(godot, dir, files, env);
  if (exists(passed)) return [];
  const errors = await checkScripts(godot, project, dir, files, env, options);
  if (errors.length === 0) await writeFileAtomic(passed, '');
  return errors;
}

/**
 * The file that marks a passed type check of these inputs: the engine binary, the files checked, and every file of the
 * project but `.godot/` (the import output of those files). The same inputs give the same result, so a check of them
 * that passed is not run again; a check with errors is always run again.
 */
async function passedCheckFile(godot: string, dir: string, files: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  const hash = createHash('sha256');
  const binary = await stat(godot);
  hash.update(`${godot}\0${String(binary.size)}\0${String(binary.mtimeMs)}\0${[...files].sort().join('\0')}\0`);
  for (const path of (await filesUnder(dir, '')).filter((p) => !p.startsWith('.godot/')).sort()) {
    hash.update(`${path}\0`);
    hash.update(await readFile(join(dir, path)));
    hash.update('\0');
  }
  const folder = join(await commonDir(harnessRoot(env), { env }), 'ogw-cache', 'godot-type-check');
  await mkdir(folder, { recursive: true });
  return join(folder, hash.digest('hex'));
}

async function checkScripts(godot: string, project: GodotProject, dir: string, files: readonly string[], env: NodeJS.ProcessEnv, options: { imported?: boolean }): Promise<GdError[]> {
  // a project the caller just imported is not imported again
  if (options.imported !== true) {
    const imported = await run(godot, ['--headless', '--path', dir, '--import'], { cwd: dir, env, timeoutMs: LIMITS.programMs });
    if (imported.timedOut) throw new OgwError('godot --import timed out');
    if (imported.code !== 0) {
      const detail = `${imported.stdout}\n${imported.stderr}`.split('\n').find((l) => /error/i.test(l))?.trim() ?? '';
      return [{ path: project.folder, line: 1, message: `godot --import failed (${String(imported.code)})${detail ? `: ${detail}` : ''}` }];
    }
  }
  return checkInOneProcess(godot, project, dir, files, env);
}

async function checkEachFile(godot: string, project: GodotProject, dir: string, files: readonly string[], env: NodeJS.ProcessEnv): Promise<GdError[]> {
  const results = await inPool(files, PARALLEL, async (path) => {
    const res = `res://${path.slice(project.folder.length + 1)}`;
    const r = await run(godot, ['--headless', '--path', dir, '--check-only', '--script', res], { cwd: dir, env, timeoutMs: LIMITS.programMs });
    if (r.timedOut) return [{ path, line: 1, message: 'godot --check-only timed out' }];
    return godotErrors(`${r.stdout}\n${r.stderr}`, path, r.code, project.repoPathOf);
  });
  return results.flat();
}

/** The script one Godot process runs to load each listed script once and print whether it is valid. */
const ONE_PROCESS_CHECKER = `extends SceneTree

func _init() -> void:
	var paths := FileAccess.get_file_as_string(OS.get_cmdline_user_args()[0]).split("\\n", false)
	for i in paths.size():
		printerr("OGW_CHECK_BEGIN %d" % i)
		var script: Script = load(paths[i])
		var valid := script != null and script.can_instantiate()
		printerr("OGW_CHECK_END %d %d" % [i, 1 if valid else 0])
	quit(0)
`;

/**
 * The type check of all files in one Godot process: it loads each script once (`--check-only` is a load and a validity
 * check of one script) and prints a marker before and after each, on stderr with the engine's error lines. An error
 * line belongs to the file its location names; a file that is not valid and has no error line of its own gets one at
 * line 1. A script whose dependency failed earlier in the process loads from the cache without the dependency's error
 * again, so the dependency's own error is the one reported (`--check-only` per file also reports every dependent).
 * When the process does not end cleanly (an error line of no script: before the first, as a project setting's missing
 * resource, between two, or after the last, as resources still in use at exit; an exit code other than 0; a timeout),
 * which file caused it is not known, so the files are checked again one process each.
 */
async function checkInOneProcess(godot: string, project: GodotProject, dir: string, files: readonly string[], env: NodeJS.ProcessEnv): Promise<GdError[]> {
  const work = await newPrivateTempFolder('ogw-gd-check-', env);
  try {
    const checker = join(work, 'ogw_check.gd');
    const list = join(work, 'files.txt');
    await writeFile(checker, ONE_PROCESS_CHECKER);
    await writeFile(list, files.map((path) => `res://${path.slice(project.folder.length + 1)}`).join('\n'));
    const r = await run(godot, ['--headless', '--path', dir, '-s', checker, '--', list], { cwd: dir, env, timeoutMs: LIMITS.programMs });
    // the markers and the engine's error lines both go to stderr, in the order they happen
    const lines = r.stderr.split('\n');
    const errors: GdError[] = [];
    const valid = new Map<number, boolean>();
    // lines of no script: before the first, between two, after the last
    const outside: string[] = [];
    let current = -1;
    let chunk: string[] = [];
    for (const line of lines) {
      const begin = /^OGW_CHECK_BEGIN (\d+)$/.exec(line);
      const end = /^OGW_CHECK_END (\d+) ([01])$/.exec(line);
      if (begin) { current = Number(begin[1]); chunk = []; continue; }
      if (end) {
        const i = Number(end[1]);
        valid.set(i, end[2] === '1');
        errors.push(...godotErrors(chunk.join('\n'), files[i] as string, 0, project.repoPathOf));
        current = -1;
        continue;
      }
      if (current >= 0) chunk.push(line);
      else outside.push(line);
    }
    if (r.timedOut || r.code !== 0 || valid.size < files.length || outside.some((line) => /^\s*(SCRIPT )?ERROR:/.test(line))) {
      return await checkEachFile(godot, project, dir, files, env);
    }
    files.forEach((path, i) => {
      if (valid.get(i) === false && !errors.some((e) => e.path === path)) errors.push({ path, line: 1, message: 'the script is not valid' });
    });
    return errors;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
