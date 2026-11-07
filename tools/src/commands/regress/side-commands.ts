/**
 * The side commands of the regression suite (ogw.md `### side` of `## regress`), which `ogw regress run` and
 * `ogw regress refresh` run with the side tool of each side. They print JSON and change no repo but the game worktrees
 * they make and remove.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext, expectPositionals, flag, list, positional, str, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { whenNotFound, writeJsonAtomic } from '../../lib/fsx.ts';
import { head, worktreeAdd, worktreeRemove } from '../../lib/git.ts';
import { newId } from '../../lib/ids.ts';
import { harnessRoot, isInside, withoutExtension } from '../../lib/paths.ts';
import type { Role } from '../../lib/settings.ts';
import { buildPrompt } from '../agent/lib/prompt.ts';
import { parseSeedRun } from '../agent/lib/prepare.ts';
import { CHECK_ORDER, regressChecks } from '../check/api.ts';
import { harnessCoreVersion } from '../core/lib/harness-core.ts';
import type { RegressCheckFile } from './lib/keys.ts';
import { runOracle } from './lib/probe.ts';
import type { SideInfo } from './lib/side.ts';

/** The harness files the links of a prompt point to: absolute link targets inside the harness repo, without anchors. */
function linkedFiles(prompt: string, harness: string): string[] {
  const targets = [...prompt.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)].map((m) => m[1] as string);
  return [...new Set(targets.filter((target) => target.startsWith('/') && isInside(harness, target)))];
}

/** The prompt bytes of a role (ogw.md `### side`): its prompt with empty input and output, and each linked harness file once. */
export async function promptBytes(harness: string, role: Role): Promise<number> {
  const prompt = await buildPrompt(harness, role, { input: '', output: '', run: null, iteration: null });
  let bytes = Buffer.byteLength(prompt, 'utf8');
  for (const file of linkedFiles(prompt, harness)) {
    const info = await stat(file).catch(whenNotFound(null));
    if (info?.isFile() === true) bytes += info.size;
  }
  return bytes;
}

export const sideCommand: CommandDef = {
  name: ['regress', 'side'],
  usage: 'ogw regress side',
  async run(ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    const harness = harnessRoot(ctx.env);
    const info: SideInfo = {
      commit: await head(harness, { env: ctx.env }),
      coreVersion: await harnessCoreVersion(ctx),
      promptBytes: { content: await promptBytes(harness, 'content'), translation: await promptBytes(harness, 'translation') },
      agents: (await ctx.settings()).agents,
      instanceLease: true,
      stepLease: true,
    };
    return { text: JSON.stringify(info), data: info };
  },
};

/** A context whose cwd is `cwd`, so that `ctx.game` gives the checkout of the worktree there. */
function contextIn(ctx: Context, cwd: string): Context {
  return createContext({
    cwd,
    env: ctx.env,
    stdin: () => ctx.stdin(),
    stderr: (text) => {
      ctx.log(text.trimEnd());
    },
  });
}

function checkNames(given: readonly string[]): string[] | null {
  if (given.length === 0) return null;
  const unknown = given.filter((name) => !CHECK_ORDER.includes(name));
  if (unknown.length > 0) throw new OgwError(`unknown check: ${unknown.join(', ')} (one of ${CHECK_ORDER.join(', ')})`);
  return given.map((name) => name);
}

export const checkCommand: CommandDef = {
  name: ['regress', 'check'],
  usage: 'ogw regress check <game> --commit <sha> --out <file> [--check <check name>...] [--performance] [--proof <records>:<n>]',
  options: { commit: { type: 'string' }, out: { type: 'string' }, check: { type: 'string', multiple: true }, performance: { type: 'boolean' }, proof: { type: 'string' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const commit = str(args, 'commit');
    const out = str(args, 'out');
    if (commit === undefined || out === undefined || !out.endsWith('.json')) throw new OgwError(`usage: ${this.usage} (--out ends with .json)`);
    // multi-word check names come as one value each when quoted; `--check no blocker` gives the words joined back
    const names = checkNames(joinedNames(list(args, 'check')));
    const proofArg = str(args, 'proof');
    const proof = proofArg === undefined ? null : parseSeedRun(proofArg);
    const game = await ctx.game(positional(args, 0, 'game'));
    const worktree = join((await ctx.workspace()).worktrees, game.name, `regress-${newId()}`);
    await worktreeAdd(game.mainRoot, worktree, commit, undefined, { env: ctx.env });
    try {
      const inside = contextIn(ctx, worktree);
      const checkout = await inside.game(game.name);
      const sha = await head(worktree, { env: ctx.env });
      const evidence = { root: withoutExtension(out), dir: '.', relative: false };
      const pick = { only: names === null ? null : new Set(names), performance: flag(args, 'performance') };
      const result = await regressChecks(inside, checkout, evidence, pick, proof === null ? null : { ...proof, commit: sha });
      const file: RegressCheckFile = { commit: sha, checks: result.checks, fixTestProof: result.fixTestProof };
      await writeJsonAtomic(out, file);
      const text = result.checks.map((c) => `${c.name}${c.platform === null ? '' : ` (${c.platform})`}: ${c.result}`).join('\n');
      return { text: `${text}\nresult file: ${out}`, data: file };
    } finally {
      await worktreeRemove(game.mainRoot, worktree, { env: ctx.env });
    }
  },
};

/** Check names from `--check` values: a value that is not a check name is joined with the next ones until it is. */
export function joinedNames(values: readonly string[]): string[] {
  const names: string[] = [];
  let pending: string[] = [];
  for (const value of values) {
    pending.push(value);
    const name = pending.join(' ');
    if (CHECK_ORDER.includes(name)) {
      names.push(name);
      pending = [];
    }
  }
  if (pending.length > 0) names.push(pending.join(' '));
  return names;
}

export const probeCommand: CommandDef = {
  name: ['regress', 'probe'],
  usage: 'ogw regress probe <game> --commit <sha> --oracle <folder> --out <file>',
  options: { commit: { type: 'string' }, oracle: { type: 'string' }, out: { type: 'string' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const commit = str(args, 'commit');
    const oracle = str(args, 'oracle');
    const out = str(args, 'out');
    if (commit === undefined || oracle === undefined || out === undefined) throw new OgwError(`usage: ${this.usage}`);
    const game = await ctx.game(positional(args, 0, 'game'));
    const result = await runOracle(ctx, game.name, commit, oracle);
    await writeJsonAtomic(out, result);
    return { text: `${result.result}${result.reason === null ? '' : `: ${result.reason}`}`, data: result };
  },
};
