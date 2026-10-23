import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
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
import { IMAGE_METHOD, keySpec, methodChoices, type Stage } from './lib/select.ts';
import { runCall, standardJob, type StageValues } from './lib/standard.ts';

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
): Promise<{ stage: Stage | null; spec: { size: [number, number] | null; lengthMs: number | null } }> {
  const { type, spec } = await keySpec(await ctx.game(gameName), key);
  const choices = await methodChoices(ctx, await ctx.settings(), type, spec);
  const sizes = { size: spec.size, lengthMs: spec.lengthMs };
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

export const runCommand: CommandDef = {
  name: ['generation', 'run'],
  usage: 'ogw generation run <method> --game <game> --key <resource key> --prompt <file> [--image <file>...] --out <dir>',
  options: { game: { type: 'string' }, key: { type: 'string' }, prompt: { type: 'string' }, image: { type: 'string', multiple: true }, out: { type: 'string' } },
  background: { game: (args) => str(args, 'game') ?? null, timeLimitMs: () => LIMITS.jobMs },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const name = positional(args, 0, 'method');
    const gameName = required(args, 'game', this.usage);
    const key = required(args, 'key', this.usage);
    const promptPath = resolve(ctx.cwd, required(args, 'prompt', this.usage));
    const out = resolve(ctx.cwd, required(args, 'out', this.usage));
    await checkOut(ctx, gameName, out);
    const images = list(args, 'image').map((p) => resolve(ctx.cwd, p));
    for (const file of [promptPath, ...images]) if (!exists(file)) throw new OgwError(`file not found: ${file}`);
    const method = (await ctx.settings()).resourceGeneration.find((m) => m.name === name);
    if (method?.kind !== 'local-model') throw new OgwError(`${name} is not a local-model method of harness settings resourceGeneration`);
    const chosen = await stageFor(ctx, method, gameName, key);
    const stage = stageValues(chosen.stage);
    const spec = chosen.spec;
    const job = standardJob(name);
    const notInstalled = `method ${name} is not installed as pinned on this host: the update env command installs it`;
    if (!(await methodMarker(ctx, method))) throw new OgwError(notInstalled);
    const dir = await methodDir(ctx, name);
    await mkdir(out, { recursive: true });
    const result = await withLock(
      join(await dataDir(ctx), 'generation', 'run.lock'),
      // The method lock keeps `generation install` from emptying the folder while the call uses it.
      () =>
        withMethodLock(ctx, name, async () => {
          const marker = await methodMarker(ctx, method);
          if (!marker) throw new OgwError(notInstalled);
          // the prompt copy is a temp file of ogw (`tools/ogw.md` `## temp folder`); the call's TMPDIR is emptied after it
          const work = await newPrivateTempFolder('ogw-generation-run-', ctx.env);
          try {
            const promptFile = join(work, 'prompt.txt');
            await writeFile(promptFile, await readText(promptPath));
            const calls = await job.call({ ctx, method, marker, dir, promptFile, images, out, stage, ...spec, seed: null });
            return await runCall(ctx, method, calls, out, LIMITS.programMs, job.outputs);
          } finally {
            await rm(work, { recursive: true, force: true });
            await rm(join(dir, 'tmp'), { recursive: true, force: true });
          }
        }),
      LIMITS.jobMs,
    );
    const blocked = result.blocked.length > 0 ? `\nblocked: ${result.blocked.join(' | ')}` : '';
    const error = result.error === undefined ? '' : `\nstderr:\n${result.error}`;
    const text = `${name}: ${result.result} in ${String(result.jobMs)}ms, output ${out}${blocked}${error}`;
    return { exitCode: result.result === 'ok' ? 0 : 1, text, data: { ...result, stage } };
  },
};
