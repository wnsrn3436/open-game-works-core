import { rm } from 'node:fs/promises';
import type { Context } from '../../../lib/command.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';
import { dependencyCheck } from './dependency.ts';
import { fixTestProof } from './proof.ts';
import { CHECKED_ENGINES, engineLint, engineTypeCheck } from './gdscript.ts';
import { secretCheck, secretNeedles } from './secret.ts';
import { checkTarget, commitTarget, coreEngines, isBenchmarkPath, isTypeDeclaration, isTypeScript, targetRepo, type CheckTarget, type Side } from './target.ts';
import { withToolReaders } from '../../core/lib/tools.ts';
import { lintTypeScript, typeCheckTypeScript, writeTsconfig } from './typescript.ts';
import { toolTestsCheck } from './tool-tests.ts';

export type CheckName = 'type check' | 'lint' | 'dependency' | 'secret' | 'fix test proof' | 'tool tests';

export interface CodeCheckItem {
  name: CheckName;
  result: 'pass' | 'fail' | 'unknown';
  failures: string[];
  /** Wall time of the check. */
  durationMs?: number;
}

async function item(name: CheckName, check: () => Promise<string[]>): Promise<CodeCheckItem> {
  const startedAt = Date.now();
  try {
    const failures = await check();
    return { name, result: failures.length === 0 ? 'pass' : 'fail', failures, durationMs: Date.now() - startedAt };
  } catch (error) {
    return { name, result: 'fail', failures: [error instanceof Error ? error.message : String(error)], durationMs: Date.now() - startedAt };
  }
}

export interface CodeCheckOptions {
  /** Fixes the `core` target to that checkout. */
  coreRoot?: string;
  /** Checks the target's files at this commit instead of the checkout's files (`ogw review next`). */
  commit?: string;
  /** Adds `fix test proof` against this commit, the start of the last review round (`ogw review next`). */
  fixBase?: string;
  /** The core review target the proof runs the tests of. */
  target?: string;
}

/** `ogw code check <core|tool>`: the checks run together. */
export async function codeCheck(ctx: Context, side: Side, options: CodeCheckOptions = {}): Promise<CodeCheckItem[]> {
  const settings = await ctx.settings();
  const work = await newPrivateTempFolder('ogw-code-check-', ctx.env);
  // the core check reads the tool folders' node_modules of open-game-works-core-impl/: no tool build replaces them meanwhile
  const items = (): Promise<CodeCheckItem[]> => checkedItems(ctx, side, options, settings, work);
  try {
    // the proof runs `ogw core test`, which may build a tool (its writer): it runs outside the readers, beside them
    const proof = options.fixBase === undefined ? null : proofItem(ctx, side, await proofRepo(ctx, side, options.coreRoot), options.fixBase, options.commit ?? 'HEAD', options.target);
    const checked = side === 'core' ? withToolReaders(ctx.env, (await ctx.workspace()).coreImpl, items) : items();
    return [...(await checked), ...(proof === null ? [] : [await proof])];
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function checkedItems(ctx: Context, side: Side, options: CodeCheckOptions, settings: Awaited<ReturnType<Context['settings']>>, work: string): Promise<CodeCheckItem[]> {
  const target = options.commit === undefined
    ? await checkTarget(ctx, side, work, options.coreRoot)
    : await commitTarget(ctx, side, options.commit, work, options.coreRoot);
  const engines = side === 'core' ? await coreEngines(target.root) : [];
  const tsconfig = await writeTsconfig(target, work);
  return Promise.all([
    item('type check', async () => (await typeCheckFailures(ctx, target, tsconfig, engines, work)).failures),
    item('lint', async () => [...(await lintTypeScript(target, tsconfig, settings.codeCheck.maxComplexity)), ...(await engineLint(ctx, target, engines))]),
    item('dependency', () => dependencyCheck(target, ctx.env)),
    item('secret', async () => secretCheck(target, await secretNeedles(ctx))),
    // the whole tool test suite of the commit a review round reads, run once for the targets of that round
    ...(side === 'tool' && options.commit !== undefined ? [item('tool tests', async () => toolTestsCheck(ctx, await targetRepo(ctx, side, options.coreRoot), options.commit as string))] : []),
  ]);
}

/**
 * The `type check` of a target: TypeScript, then the engine code. A part that stops with an error gives its message
 * as one failure line, and the failure lines of the other part are kept.
 */
async function typeCheckFailures(ctx: Context, target: CheckTarget, tsconfig: string | null, engines: readonly string[], work: string): Promise<TypeCheckAt> {
  const stops: TypeCheckStop[] = [];
  const stopped = (part: TypeCheckPart) => (error: unknown): string[] => {
    const reason = error instanceof Error ? error.message : String(error);
    stops.push({ part, reason });
    return [reason];
  };
  const typeScript = await typeCheckTypeScript(target, tsconfig).catch(stopped('TypeScript'));
  const engine = await engineTypeCheck(ctx, target, engines, work).catch(stopped('engine'));
  return { failures: [...typeScript, ...engine], complete: stops.length === 0, stops };
}

/** A part of the `type check`. */
export type TypeCheckPart = 'TypeScript' | 'engine';

/** A part of the `type check` that stopped with an error before it checked, and that error's message. */
export interface TypeCheckStop {
  part: TypeCheckPart;
  reason: string;
}

/** The `type check` of `ogw code check core` alone, on the files of a commit. */
export interface TypeCheckAt {
  /** Its failure lines, as `ogw code check` gives them. */
  failures: string[];
  /** False when a part of the check stopped with an error (its message is a failure line) instead of ending. */
  complete: boolean;
  /** The parts that stopped. */
  stops: TypeCheckStop[];
}

/**
 * Whether a part of the `type check` covers the file `path` of `open-game-works-core-impl/`: the TypeScript part its
 * TypeScript source and declaration files, the engine part the files of an engine project `client/<engine>/` it
 * checks (`CHECKED_ENGINES`): its GDScript and the files the engine project is made of.
 */
export function partCovers(part: TypeCheckPart, path: string): boolean {
  if (part === 'TypeScript') return !isBenchmarkPath(path) && (isTypeScript(path) || isTypeDeclaration(path));
  return CHECKED_ENGINES.some((engine) => path.startsWith(`client/${engine}/`) && path.length > `client/${engine}/`.length);
}

/**
 * The `type check` of `ogw code check core` on the `core` target's files at `commit` of the checkout `coreRoot`
 * (`ogw agent merge`): the same check, without the other checks.
 */
export async function coreTypeCheckAt(ctx: Context, commit: string, coreRoot: string): Promise<TypeCheckAt> {
  const work = await newPrivateTempFolder('ogw-code-check-', ctx.env);
  try {
    return await withToolReaders(ctx.env, (await ctx.workspace()).coreImpl, async () => {
      const target = await commitTarget(ctx, 'core', commit, work, coreRoot);
      const tsconfig = await writeTsconfig(target, work);
      return typeCheckFailures(ctx, target, tsconfig, await coreEngines(target.root), work);
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The repo the proof reads (the target's checkout repo). */
function proofRepo(ctx: Context, side: Side, coreRoot: string | undefined): Promise<string> {
  return targetRepo(ctx, side, coreRoot);
}

async function proofItem(ctx: Context, side: Side, repo: string, base: string, commit: string, target: string | undefined): Promise<CodeCheckItem> {
  const startedAt = Date.now();
  try {
    return { name: 'fix test proof', ...(await fixTestProof(ctx, side, repo, base, commit, target)), durationMs: Date.now() - startedAt };
  } catch (error) {
    return { name: 'fix test proof', result: 'unknown', failures: [error instanceof Error ? error.message : String(error)], durationMs: Date.now() - startedAt };
  }
}

export function formatItems(items: readonly CodeCheckItem[]): string {
  return items.flatMap((i) => [`${i.name}: ${i.result}${i.durationMs === undefined ? '' : ` (${String(Math.round(i.durationMs / 1000))} s)`}`, ...i.failures.map((failure) => `  ${failure}`)]).join('\n');
}
