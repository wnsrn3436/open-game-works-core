import type { Context } from '../../lib/command.ts';
import { codeCheck, coreTypeCheckAt, type CodeCheckItem, type TypeCheckAt } from './lib/run.ts';

export { partCovers } from './lib/run.ts';
export type { CodeCheckItem, TypeCheckAt, TypeCheckStop } from './lib/run.ts';

/**
 * `ogw code check <core|tool>`. `coreRoot` fixes the `core` target to that checkout instead of the one the
 * command's folder picks (`open-game-works-core-impl/` or the core worktree it runs in).
 */
export function runCodeCheck(ctx: Context, side: 'core' | 'tool', coreRoot?: string): Promise<CodeCheckItem[]> {
  return codeCheck(ctx, side, coreRoot === undefined ? {} : { coreRoot });
}

/** The `type check` of `ogw code check core` alone, on the files at `commit` of the checkout `coreRoot`. */
export function runCoreTypeCheck(ctx: Context, commit: string, coreRoot: string): Promise<TypeCheckAt> {
  return coreTypeCheckAt(ctx, commit, coreRoot);
}
