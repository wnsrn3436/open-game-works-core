import { OgwError } from '../../../lib/errors.ts';
import type { Finding, StaticContext } from './lib/context.ts';
import { gameEngine } from './lib/engine.ts';

/**
 * object destroy (`client-core` `## engine`): in an engine whose implementation rules define a core destroy function,
 * code destroys an object outside it. The Godot rules define none (the engine destroys objects), so a Godot game has
 * nothing to check.
 */
export const NAME = 'object destroy';

/** Engines whose implementation rules define no core destroy function. */
const NO_DESTROY_FUNCTION = new Set(['godot']);

export async function run(sc: StaticContext): Promise<Finding[]> {
  const engine = await gameEngine(sc);
  if (NO_DESTROY_FUNCTION.has(engine)) return [];
  throw new OgwError(`not defined: static check object destroy for engine ${engine}`);
}
