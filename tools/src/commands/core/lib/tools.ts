/**
 * The contract tool and the data tool in `open-game-works-core-impl/tools/` (`core` command.md `### create contract tool`):
 * build into `bin/<tool>.js`, the tool package of a release, the `tools` module tests, and the base proto
 * comparison of `ogw core release`.
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, readJsonIfExists, removeModulesLink } from '../../../lib/fsx.ts';
import { checkoutLock } from '../../../lib/git.ts';
import { newId } from '../../../lib/ids.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { withReader, withWriter, type RwLock } from '../../../lib/rwlock.ts';
import { run, type RunResult } from '../../../lib/proc.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';
import { serverRunFailures, unitTestResult, type ServerTestRun, type VitestJson } from './server-tests.ts';

export type ToolName = 'contract-tool' | 'data-tool';

/** The tools, which are also the module names of the `tools` target of `ogw core test`. */
export const TOOLS: readonly ToolName[] = ['contract-tool', 'data-tool'];

export function toolDir(implDir: string, tool: string): string {
  return join(implDir, 'tools', tool);
}

/** True when `open-game-works-core-impl/tools/<tool>/package.json` exists. */
export function hasTool(implDir: string, tool: string): boolean {
  return exists(join(toolDir(implDir, tool), 'package.json'));
}

/** The tools that have an implementation in `open-game-works-core-impl/tools/`. */
export function implementedTools(implDir: string): ToolName[] {
  return TOOLS.filter((tool) => hasTool(implDir, tool));
}

function output(result: RunResult): string {
  const text = [result.stdout.trim(), result.stderr.trim()].filter((s) => s !== '').join('\n');
  return text === '' ? '' : `:\n${text}`;
}

async function npm(env: NodeJS.ProcessEnv, dir: string, args: string[], what: string): Promise<void> {
  const result = await run('npm', args, { cwd: dir, env, timeoutMs: LIMITS.programMs });
  if (result.timedOut) throw new OgwError(`${what}: npm ${args.join(' ')} timed out`);
  if (result.code !== 0) throw new OgwError(`${what}: npm ${args.join(' ')} failed (${String(result.code)})${output(result)}`);
}

/** Builds done for one command run, keyed by its `env` object, so one command builds each tool once. */
const builds = new WeakMap<NodeJS.ProcessEnv, Map<string, Promise<string>>>();

/**
 * Builds a tool once per command run: `npm ci` and `npm run build` in `open-game-works-core-impl/tools/<tool>/`.
 * Returns the absolute path of the `bin/<tool>.js` the build made.
 */
export function buildTool(env: NodeJS.ProcessEnv, implDir: string, tool: ToolName): Promise<string> {
  const done = builds.get(env) ?? new Map<string, Promise<string>>();
  builds.set(env, done);
  const key = toolDir(implDir, tool);
  let build = done.get(key);
  if (!build) {
    build = buildToolNow(env, implDir, tool);
    done.set(key, build);
    build.catch(() => done.delete(key));
  }
  return build;
}

/**
 * The lock of a tool folder: a build (`npm ci`, `npm run build`) is its writer, and every use of its `node_modules/` or
 * built `bin/` is a reader, so no command replaces them under another.
 */
async function toolLock(env: NodeJS.ProcessEnv, implDir: string, tool: ToolName): Promise<RwLock> {
  return { base: await checkoutLock(implDir, `ogw-${tool}-build.lock`, { env }), waitMs: LIMITS.jobMs };
}

/**
 * Runs `fn` as a reader of every tool folder of `implDir` (`toolLock`): what reads a tool's `node_modules/` (`ogw code
 * check`) does not overlap a build that replaces it.
 */
export async function withToolReaders<T>(env: NodeJS.ProcessEnv, implDir: string, fn: () => Promise<T>): Promise<T> {
  let run = fn;
  for (const tool of TOOLS.filter((t) => hasTool(implDir, t))) {
    const inner = run;
    const lock = await toolLock(env, implDir, tool);
    run = () => withReader(lock, inner);
  }
  return run();
}

/** Builds the tool once per command run (`buildTool`), then runs `fn` with its `bin/<tool>.js` as a reader of the folder. */
export async function withBuiltTool<T>(env: NodeJS.ProcessEnv, implDir: string, tool: ToolName, fn: (entry: string) => Promise<T>): Promise<T> {
  const entry = await buildTool(env, implDir, tool);
  return withReader(await toolLock(env, implDir, tool), () => fn(entry));
}

async function buildToolNow(env: NodeJS.ProcessEnv, implDir: string, tool: ToolName): Promise<string> {
  const dir = toolDir(implDir, tool);
  if (!hasTool(implDir, tool)) throw new OgwError(`${tool}: no tools/${tool}/package.json in ${implDir}`);
  await withWriter(await toolLock(env, implDir, tool), async () => {
    await removeModulesLink(dir);
    // no audit or fund request: they need the registry beyond the packages, and a hung one held the tool lock
    await npm(env, dir, ['ci', '--no-audit', '--no-fund'], tool);
    await npm(env, dir, ['run', 'build'], tool);
  });
  const entry = join(dir, 'bin', `${tool}.js`);
  if (!exists(entry)) throw new OgwError(`${tool}: npm run build made no bin/${tool}.js`);
  return entry;
}

/** Puts the files of `<tool>.tgz` except `proto/` into `stageDir`: the built `bin/<tool>.js`. */
export async function stageToolPackage(env: NodeJS.ProcessEnv, implDir: string, tool: ToolName, stageDir: string): Promise<void> {
  await withBuiltTool(env, implDir, tool, async (entry) => {
    await mkdir(join(stageDir, 'bin'), { recursive: true });
    await cp(entry, join(stageDir, 'bin', `${tool}.js`));
  });
}

/** Counts and failures of one tool test. */
export interface ToolTestOutcome {
  tests: number;
  passed: number;
  failures: string[];
  /** Whether vitest was started (`ModuleOutcome.ran`). Absent: true. */
  ran?: boolean;
}

/**
 * The vitest tests of a built tool: `vitest run` in `tools/<tool>/` with the JSON reporter, judged by the server test
 * run rules (`unitTestResult`, `serverRunFailures`) with `skip` as a failure. Test files are named relative to the tool folder.
 */
export async function runVitest(ctx: Context, implDir: string, tool: string, work: string): Promise<ToolTestOutcome> {
  const dir = toolDir(implDir, tool);
  const vitest = join(dir, 'node_modules', '.bin', 'vitest');
  if (!exists(vitest)) return { tests: 0, passed: 0, failures: [`${tool}: no node_modules/.bin/vitest (vitest is not a devDependency)`], ran: false };
  const reportFile = join(work, `vitest-${tool}.json`);
  const startedAt = Date.now();
  const result = await run(vitest, ['run', '--reporter=json', `--outputFile=${reportFile}`], { cwd: dir, env: ctx.env, timeoutMs: LIMITS.programMs });
  const report = await readJsonIfExists<VitestJson>(reportFile);
  const meta = { runId: newId(), kind: 'core' as const, checkout: dir, startedAt, finishedAt: Date.now() };
  const testRun: ServerTestRun = {
    result: report === null ? null : unitTestResult(report, meta),
    output: `${result.stdout}${result.stderr}`,
    timedOut: result.timedOut,
    exitCode: result.code,
  };
  const results = testRun.result?.results ?? [];
  return {
    tests: results.length,
    passed: results.filter((test) => test.status === 'pass').length,
    failures: serverRunFailures(testRun, 'tool', tool, LIMITS.programMs).map((failure) => `${tool} vitest: ${failure.message}`.trimEnd()),
  };
}

/** Folder that holds `proto/` and `core-settings.json` of a lower release for `--base-proto-only`. */
export interface PreviousBaseProto {
  /** `proto/` of that release's `contract-tool.tgz`. */
  proto: string;
  /** `core-settings.json` of that release. */
  coreSettings: string;
}

async function copyOrEmpty(from: string, to: string): Promise<void> {
  if (exists(from)) await cp(from, to);
  else await writeFile(to, '{}\n');
}

/**
 * Breaking changes between the base proto of a lower release and the base proto of `open-game-works-core-impl/`,
 * by the contract tool of `open-game-works-core-impl/` with `--base-proto-only` (`contract` tool.md `## CLI`).
 */
export async function compareBaseProto(ctx: Context, implDir: string, previous: PreviousBaseProto): Promise<string[]> {
  const work = await newPrivateTempFolder('ogw-base-proto-', ctx.env);
  try {
    const dir = join(work, 'previous');
    await mkdir(dir, { recursive: true });
    await cp(previous.proto, join(dir, 'proto'), { recursive: true });
    // a release or a checkout without core settings has no `_key` value to read: `{}` stands for it
    await copyOrEmpty(previous.coreSettings, join(dir, 'core-settings.json'));
    const current = join(work, 'core-settings.json');
    await copyOrEmpty(join(implDir, 'settings', 'core-settings.json'), current);
    const result = await withBuiltTool(ctx.env, implDir, 'contract-tool', (entry) => {
      const args = [entry, '--base-proto-only', '--base-proto', join(implDir, 'proto'), '--core-settings', current, '--previous', dir];
      return run(process.execPath, args, { cwd: implDir, env: ctx.env, timeoutMs: LIMITS.programMs });
    });
    if (result.timedOut) throw new OgwError('contract-tool --base-proto-only timed out');
    if (result.code === 0) return [];
    const lines = result.stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '');
    if (result.code === 1 && lines.length > 0) return lines;
    throw new OgwError(`contract-tool --base-proto-only failed (${String(result.code)})${output(result)}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
