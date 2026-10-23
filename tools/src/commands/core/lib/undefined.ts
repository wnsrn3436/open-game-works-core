/**
 * Steps the harness documents do not define yet. Each fails with `not defined: <what>` until the
 * definition exists; the rest of the core commands is built around them. Tests replace this module.
 */
import { OgwError } from '../../../lib/errors.ts';

/** Test counts and failures (failed test names and run failures) of one module test. */
export interface ModuleTestOutcome {
  tests: number;
  passed: number;
  failures: string[];
}

/** The error of an undefined step. `inputs` are the values the step would work on (kept in the error data). */
function notDefined(what: string, ...inputs: unknown[]): OgwError {
  return new OgwError(`not defined: ${what}`, 1, { inputs });
}

/** Files of `client-<engine>.zip` and `client-<engine>-plugins.zip` for an engine other than Godot. */
export function engineAssetRules(engine: string): never {
  throw notDefined(`client core rules of engine ${engine} (release assets, project layout, test run)`);
}
