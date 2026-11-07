import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { checkoutLock } from '../../../lib/git.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { withLock } from '../../../lib/lock.ts';
import { exists } from '../../../lib/fsx.ts';
import { run } from '../../../lib/proc.ts';
import type { GameSettings } from '../../../lib/settings.ts';
import { installEnginePackages } from '../../generate/api.ts';
import { withHeavyStep } from '../../generation/lib/lease.ts';
import { engineExecutable } from '../../instance/lib/prepare.ts';

/** Executable of the engine version the game uses (`engineExecutable` of the runner). Fails when this host does not have it. */
export async function gameEngine(ctx: Context, game: GameRepo, settings: GameSettings): Promise<string> {
  const engine = settings.engine;
  if (typeof engine !== 'string' || engine === '') throw new OgwError('game settings engine is not set');
  return engineExecutable(ctx, game, engine);
}

/** A merged core settings value by its key (`<Module>.<key>`), flat or nested. */
export function coreSetting(settings: Record<string, unknown>, key: string): unknown {
  if (key in settings) return settings[key];
  const [module = '', name = ''] = key.split('.');
  const nested = settings[module];
  return typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>)[name] : undefined;
}

/**
 * Runs `fn`, which imports or reads the checkout's `client/.godot/`, under the lock the runner's engine import takes
 * (`importIfNeeded`), so imports of one checkout in this and other processes do not rewrite it at the same time.
 * A holder may run a whole type check, so the wait is that of a job.
 */
export async function withClientImport<T>(ctx: Context, root: string, fn: () => Promise<T>): Promise<T> {
  return withLock(await checkoutLock(root, 'ogw-import.lock', { env: ctx.env }), fn, LIMITS.jobMs);
}

/**
 * Runs `fn`, a step of a check that imports the checkout's `client/` or runs Godot on it, under {@link withClientImport}
 * once the engine packages of `ogw generate` are in `client/` (`installEnginePackages`): `client/addons/` is not
 * committed, so a checkout no `ogw generate` ran in has no GUT and no plugins (ogw.md `## check`).
 */
export async function withClientPackages<T>(ctx: Context, game: GameRepo, fn: () => Promise<T>): Promise<T> {
  return withClientImport(ctx, game.root, async () => {
    await installEnginePackages(ctx, game);
    return fn();
  });
}

/**
 * `godot --headless --path client --import` of the checkout under {@link withClientPackages}, as a heavy step of the check
 * (ogw.md `### performance lease`), which waits for the lease before it takes the lock. Returns null when it succeeded,
 * else the failure message. A failed import removes `client/.godot/` before the lock is released (ogw.md `## runner`),
 * so no instance of the checkout starts on a broken import.
 */
export async function importClient(ctx: Context, godot: string, game: GameRepo): Promise<string | null> {
  return withHeavyStep(ctx, game, () => withClientPackages(ctx, game, () => runImport(ctx, godot, game.root)));
}

/**
 * {@link importClient} when `client/.godot/` is still missing once the lock is held: another job may have imported
 * the checkout while this one waited. Returns whether it ran and the failure message, or null.
 */
export async function importClientIfMissing(ctx: Context, godot: string, root: string): Promise<{ ran: boolean; failed: string | null }> {
  return withClientImport(ctx, root, async () => {
    if (exists(join(root, 'client', '.godot'))) return { ran: false, failed: null };
    return { ran: true, failed: await runImport(ctx, godot, root) };
  });
}

async function runImport(ctx: Context, godot: string, root: string): Promise<string | null> {
  const project = join(root, 'client');
  const imported = join(project, '.godot');
  let why: string;
  try {
    const result = await run(godot, ['--headless', '--path', project, '--import'], { cwd: root, env: ctx.env, timeoutMs: LIMITS.programMs });
    if (result.code === 0 && !result.timedOut && exists(imported)) return null;
    why = result.timedOut ? 'timed out' : result.code === 0 ? `no ${imported}` : String(result.code ?? result.signal);
  } catch (error) {
    why = (error as Error).message;
  }
  await rm(imported, { recursive: true, force: true });
  return `godot --import failed (${why})`;
}
