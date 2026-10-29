import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { expectPositionals, list, positional, str, type CommandArgs, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, readText } from '../../lib/fsx.ts';
import { LIMITS } from '../../lib/limits.ts';
import { withLock } from '../../lib/lock.ts';
import { isInside } from '../../lib/paths.ts';
import { newPrivateTempFolder } from '../../lib/secret-files.ts';
import type { GenerationMethod } from '../../lib/settings.ts';
import { dataDir } from '../env/lib/host.ts';
import { methodDir, methodMarker, withMethodLock } from './lib/install.ts';
import { gameImageMethod, IMAGE_METHOD, keySpec, methodChoices, type Stage } from './lib/select.ts';
import { outputsPresent, runCall, standardJob, type CallInput, type StageValues, type StandardJob } from './lib/standard.ts';
import type { MeasuredRun } from '../env/lib/results.ts';

function required(args: CommandArgs, name: string, usage: string): string {
  const value = str(args, name);
  if (value === undefined) throw new OgwError(`usage: ${usage}`);
  return value;
}

/**
 * The stage `generation methods` gives this method for the key, and the `spec` `size` and `length` of the key;
 * throws when the method is not in that output.
 */
async function stageFor(
  ctx: Context,
  method: GenerationMethod,
  gameName: string,
  key: string,
): Promise<{ stage: Stage | null; spec: { size: [number, number] | null; lengthMs: number | null; loop: boolean } }> {
  const settings = await ctx.settings();
  const { type, spec, rows } = await keySpec(await ctx.game(gameName), key);
  const choices = await methodChoices(ctx, settings, type, spec, gameImageMethod(settings, rows));
  const sizes = { size: spec.size, lengthMs: spec.lengthMs, loop: spec.loop };
  const own = choices.find((c) => c.name === method.name);
  if (own) return { stage: own.stage, spec: sizes };
  const viaImage = method.name === IMAGE_METHOD ? choices.find((c) => c.flux2Klein !== undefined) : undefined;
  if (viaImage) return { stage: viaImage.flux2Klein ?? null, spec: sizes };
  throw new OgwError(`method ${method.name} is not in ogw generation methods ${gameName} ${key}`);
}

/** Real path of a path that may not exist yet: the real path of its nearest existing folder, then the rest. */
async function realPathOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await realPathOf(parent), basename(path));
  }
}

/**
 * `--out` is a folder outside the game repo (`production.md` `## method`): not inside the game repo, its main
 * checkout or a worktree of the game, and not a folder that holds one of them, since the sandbox lets the call write
 * anywhere in `--out`.
 */
async function checkOut(ctx: Context, gameName: string, out: string): Promise<void> {
  const game = await ctx.game(gameName);
  const real = await realPathOf(out);
  const repos = [game.root, game.mainRoot, join((await ctx.workspace()).worktrees, gameName)];
  for (const repo of await Promise.all(repos.map(realPathOf))) {
    if (isInside(repo, real) || isInside(real, repo)) throw new OgwError(`--out must be a folder outside game repo ${gameName}: ${out}`);
  }
}

function stageValues(stage: Stage | null): StageValues | null {
  if (stage === null) return null;
  return {
    ...(stage.resolution === undefined ? {} : { resolution: stage.resolution }),
    ...(stage.durationMs === undefined ? {} : { durationMs: stage.durationMs }),
  };
}

/** One resource key to make: given by `--key`, `--prompt`, `--image` and `--out`, or by an item of `--batch`. */
interface Item {
  key: string;
  prompt: string;
  images: string[];
  out: string;
}

const USAGE = 'ogw generation run <method> --game <game> (--key <resource key> --prompt <file> [--image <file>...] --out <dir> | --batch <file>)';

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** The items of the call: the one the flags give, or each item of the `--batch` file (`[{"key", "prompt", "images"?, "out"}, ...]`). */
async function itemsOf(ctx: Context, args: CommandArgs): Promise<Item[]> {
  const batch = str(args, 'batch');
  if (batch === undefined) {
    const out = resolve(ctx.cwd, required(args, 'out', USAGE));
    return [{ key: required(args, 'key', USAGE), prompt: resolve(ctx.cwd, required(args, 'prompt', USAGE)), images: list(args, 'image').map((p) => resolve(ctx.cwd, p)), out }];
  }
  if (['key', 'prompt', 'out'].some((name) => str(args, name) !== undefined) || list(args, 'image').length > 0) throw new OgwError(`--batch goes without --key, --prompt, --image and --out\nusage: ${USAGE}`);
  const file = resolve(ctx.cwd, batch);
  let raw: unknown;
  try {
    raw = JSON.parse(await readText(file));
  } catch (error) {
    throw new OgwError(`--batch ${batch}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new OgwError(`--batch ${batch} is not a non-empty JSON array of {"key", "prompt", "images", "out"}`);
  const items = raw.map((entry: unknown, i): Item => {
    const e = entry as Record<string, unknown> | null;
    const images = e?.images ?? [];
    if (typeof e?.key !== 'string' || typeof e.prompt !== 'string' || typeof e.out !== 'string' || !isStringList(images)) {
      throw new OgwError(`--batch ${batch} item ${String(i + 1)} is not {"key", "prompt", "images", "out"}`);
    }
    return { key: e.key, prompt: resolve(ctx.cwd, e.prompt), images: images.map((p) => resolve(ctx.cwd, p)), out: resolve(ctx.cwd, e.out) };
  });
  // the same folder by two spellings (a symlink, /tmp and /private/tmp) is one folder
  const reals = await Promise.all(items.map((i) => realPathOf(i.out)));
  if (new Set(reals).size !== items.length) throw new OgwError(`--batch ${batch} gives one out folder to two items`);
  return items;
}

interface ItemResult {
  key: string;
  out: string;
  result: 'ok' | 'failed' | 'timeout';
  /** Why the item failed: the `ogw-error.txt` a driver left in its out folder, or the error of its own call. */
  error?: string;
}

/** The file in which a driver gives why an item failed (`tools/ogw.md` `## generation call`). */
const ITEM_ERROR = 'ogw-error.txt';

async function itemError(out: string): Promise<string | undefined> {
  const text = await readFile(join(out, ITEM_ERROR), 'utf8').catch(() => null);
  return text === null ? undefined : (text.trim().split('\n')[0] ?? '').slice(0, 300);
}

/** The time limit of a batch: one call per item, below the time limit of its background job. */
function batchTimeoutMs(items: number): number {
  return Math.min(LIMITS.programMs * items, LIMITS.jobMs - LIMITS.programMs);
}

export const runCommand: CommandDef = {
  name: ['generation', 'run'],
  usage: USAGE,
  options: { game: { type: 'string' }, key: { type: 'string' }, prompt: { type: 'string' }, image: { type: 'string', multiple: true }, out: { type: 'string' }, batch: { type: 'string' } },
  background: { game: (args) => str(args, 'game') ?? null, timeLimitMs: () => LIMITS.jobMs },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const name = positional(args, 0, 'method');
    const gameName = required(args, 'game', this.usage);
    const items = await itemsOf(ctx, args);
    for (const item of items) {
      await checkOut(ctx, gameName, item.out);
      for (const file of [item.prompt, ...item.images]) if (!exists(file)) throw new OgwError(`file not found: ${file}`);
    }
    const method = (await ctx.settings()).resourceGeneration.find((m) => m.name === name);
    if (method?.kind !== 'local-model') throw new OgwError(`${name} is not a local-model method of harness settings resourceGeneration`);
    const chosen = await Promise.all(items.map((item) => stageFor(ctx, method, gameName, item.key)));
    const job = standardJob(name);
    const notInstalled = `method ${name} is not installed as pinned on this host: the update env command installs it`;
    if (!(await methodMarker(ctx, method))) throw new OgwError(notInstalled);
    const dir = await methodDir(ctx, name);
    for (const item of items) await mkdir(item.out, { recursive: true });
    const batch = str(args, 'batch') !== undefined;
    const outcome = await withLock(
      join(await dataDir(ctx), 'generation', 'run.lock'),
      // The method lock keeps `generation install` from emptying the folder while the call uses it.
      () =>
        withMethodLock(ctx, name, async () => {
          const marker = await methodMarker(ctx, method);
          if (!marker) throw new OgwError(notInstalled);
          // the prompt copies are temp files of ogw (`tools/ogw.md` `## temp folder`); the call's TMPDIR is emptied after it
          const work = await newPrivateTempFolder('ogw-generation-run-', ctx.env);
          try {
            const inputs: CallInput[] = [];
            for (const [i, item] of items.entries()) {
              const promptFile = join(work, `prompt-${String(i + 1)}.txt`);
              await writeFile(promptFile, await readText(item.prompt));
              const { stage, spec } = chosen[i] as Awaited<ReturnType<typeof stageFor>>;
              inputs.push({ ctx, method, marker, dir, promptFile, images: item.images, out: item.out, stage: stageValues(stage), ...spec, seed: null });
            }
            if (!batch) {
              const input = inputs[0] as CallInput;
              const run = await runCall(ctx, method, await job.call(input), input.out, LIMITS.programMs, job.outputs);
              return { runs: [run], results: [{ key: (items[0] as Item).key, out: input.out, result: run.result }] };
            }
            // what an out folder already holds is not taken for what this call made
            // an input image of an item (an image edited in place) is never removed
            const inputImages = new Set(await Promise.all(items.flatMap((i) => i.images).map(realPathOf)));
            for (const item of items) {
              for (const output of [...(job.outputs ?? []), ITEM_ERROR]) {
                const path = join(item.out, output);
                if (!inputImages.has(await realPathOf(path))) await rm(path, { force: true });
              }
            }
            return job.batch === undefined ? await eachItem(ctx, method, job, inputs, items) : await oneCall(ctx, method, job, inputs, items);
          } finally {
            await rm(work, { recursive: true, force: true });
            await rm(join(dir, 'tmp'), { recursive: true, force: true });
          }
        }),
      LIMITS.jobMs,
    );
    const failed = outcome.results.some((r) => r.result !== 'ok');
    const notes = (run: MeasuredRun): string =>
      `${run.blocked.length > 0 ? `\nblocked: ${run.blocked.join(' | ')}` : ''}${run.error === undefined ? '' : `\nstderr:\n${run.error}`}`;
    if (!batch) {
      const result = outcome.runs[0] as MeasuredRun;
      const stage = stageValues((chosen[0] as Awaited<ReturnType<typeof stageFor>>).stage);
      return { exitCode: failed ? 1 : 0, text: `${name}: ${result.result} in ${String(result.jobMs)}ms, output ${(items[0] as Item).out}${notes(result)}`, data: { ...result, stage } };
    }
    const jobMs = outcome.runs.reduce((sum, r) => sum + (r.jobMs ?? 0), 0);
    const ok = outcome.results.filter((r) => r.result === 'ok').length;
    const lines = [
      `${name}: ${String(ok)} of ${String(items.length)} ok in ${String(jobMs)}ms`,
      ...outcome.results.map((r) => `${r.key}: ${r.result}, output ${r.out}${r.error === undefined ? '' : `: ${r.error}`}`),
    ];
    const blocked = [...new Set(outcome.runs.flatMap((r) => r.blocked))];
    const data = { items: outcome.results, jobMs, batched: job.batch !== undefined, blocked, maxMemoryBytes: Math.max(0, ...outcome.runs.map((r) => r.maxMemoryBytes ?? 0)) || null };
    return { exitCode: failed ? 1 : 0, text: `${lines.join('\n')}${blocked.length > 0 ? `\nblocked: ${blocked.join(' | ')}` : ''}`, data };
  },
};

/**
 * A batch of a method with a driver: one call that loads the model once. An item is `ok` when its out folder has the
 * outputs after the call, a call cut off at its time limit included, since a driver puts each output in only when made.
 */
async function oneCall(ctx: Context, method: GenerationMethod, job: StandardJob, inputs: CallInput[], items: readonly Item[]): Promise<{ runs: MeasuredRun[]; results: ItemResult[] }> {
  const run = await runCall(ctx, method, await (job.batch as NonNullable<StandardJob['batch']>)(inputs), items.map((i) => i.out), batchTimeoutMs(items.length), job.outputs);
  const results: ItemResult[] = [];
  for (const item of items) {
    if (await outputsPresent(item.out, job.outputs)) {
      results.push({ key: item.key, out: item.out, result: 'ok' });
      continue;
    }
    const error = (await itemError(item.out)) ?? (run.result === 'failed' ? run.error?.trim().split('\n').at(-1) : undefined);
    results.push({ key: item.key, out: item.out, result: run.result === 'timeout' && error === undefined ? 'timeout' : 'failed', ...(error === undefined ? {} : { error }) });
  }
  return { runs: [run], results };
}

/** A batch of a method without a driver: its calls item by item; an item whose call cannot be made fails, and the others go on. */
async function eachItem(ctx: Context, method: GenerationMethod, job: StandardJob, inputs: CallInput[], items: readonly Item[]): Promise<{ runs: MeasuredRun[]; results: ItemResult[] }> {
  const runs: MeasuredRun[] = [];
  const results: ItemResult[] = [];
  for (const [i, input] of inputs.entries()) {
    const item = items[i] as Item;
    let calls: Awaited<ReturnType<StandardJob['call']>>;
    try {
      calls = await job.call(input);
    } catch (error) {
      results.push({ key: item.key, out: item.out, result: 'failed', error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const run = await runCall(ctx, method, calls, input.out, LIMITS.programMs, job.outputs);
    runs.push(run);
    const error = run.error?.trim().split('\n').at(-1);
    results.push({ key: item.key, out: item.out, result: run.result, ...(run.result !== 'ok' && error !== undefined ? { error } : {}) });
  }
  return { runs, results };
}
