/** The oracle of a seed (ogw.md `### oracle` of `## regress`): a probe module run on an instance per language. */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Context } from '../../../lib/command.ts';
import { exists, readJson } from '../../../lib/fsx.ts';
import { isPlainObject } from '../../../lib/json.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { automationRequest, restartClient } from '../../instance/automation.ts';
import { startInstance, stopInstance } from '../../instance/api.ts';
import type { ProbeResult } from './side.ts';

/** `oracle/oracle.json`; `fixture` is null for an instance started without a save fixture. */
export interface OracleFile {
  fixture: string | null;
  probe: string;
  languages: string[];
}

/** What the probe module gets per call. */
export interface ProbeApi {
  language: string;
  command(name: string, ...args: string[]): Promise<{ ok: boolean; result: unknown }>;
}

type ProbeFn = (probe: ProbeApi) => Promise<{ result: 'pass' | 'fail'; reason: string }>;

function oracleError(reason: string): ProbeResult {
  return { result: 'unknown', reason };
}

/** `oracle.json` of `folder` with its files inside `folder`, or why it cannot be used. */
export async function readOracle(folder: string): Promise<OracleFile | string> {
  const path = join(folder, 'oracle.json');
  if (!exists(path)) return `${path} not found`;
  const value: unknown = await readJson(path);
  const fixture = isPlainObject(value) && typeof value.fixture === 'string' ? value.fixture : null;
  if (!isPlainObject(value) || (value.fixture !== undefined && fixture === null) || typeof value.probe !== 'string' || !Array.isArray(value.languages) || value.languages.length === 0) {
    return `${path} is not {"probe", "languages", "fixture" (optional)} with at least one language`;
  }
  for (const file of [fixture, value.probe]) if (file !== null && !exists(resolve(folder, file))) return `${resolve(folder, file)} not found`;
  return { fixture, probe: value.probe, languages: value.languages.map(String) };
}

/**
 * Runs the oracle of `folder` on commit `commit` of `game`: one instance with the save fixture and a client that draws
 * the screen; per language `set_language` (the client restarts to `boot_stage` `Done`) and the probe. `fail` when a call
 * gives `fail`, `pass` when every call gives `pass`, `unknown` when the instance does not start or the probe throws.
 */
export async function runOracle(ctx: Context, game: string, commit: string, folder: string): Promise<ProbeResult> {
  const oracle = await readOracle(folder);
  if (typeof oracle === 'string') return oracleError(oracle);
  let probe: ProbeFn;
  try {
    const module = (await import(pathToFileURL(resolve(folder, oracle.probe)).href)) as { default?: unknown };
    if (typeof module.default !== 'function') return oracleError(`${oracle.probe} has no default export function`);
    probe = module.default as ProbeFn;
  } catch (error) {
    return oracleError(`${oracle.probe} does not load: ${(error as Error).message}`);
  }
  let id: string | null = null;
  try {
    const fixture = oracle.fixture === null ? {} : { fixture: resolve(folder, oracle.fixture) };
    id = (await startInstance(ctx, { game, commit, client: 'window', ...fixture })).id;
  } catch (error) {
    return oracleError(`the instance did not start: ${(error as Error).message}`);
  }
  const instance = id;
  try {
    const reasons: string[] = [];
    for (const language of oracle.languages) {
      await restartClient(ctx, instance, 'main', { command: 'set_language', args: [language], timeoutMs: LIMITS.httpMs });
      const api: ProbeApi = {
        language,
        command: async (name, ...args) => {
          const response = await automationRequest(ctx, instance, name, args, 'main', { access: 'full' });
          return { ok: response.ok, result: response.result };
        },
      };
      const answer = await probe(api);
      if (answer.result === 'fail') return { result: 'fail', reason: `${language}: ${answer.reason}` };
      reasons.push(`${language}: ${answer.reason}`);
    }
    return { result: 'pass', reason: reasons.join('; ') };
  } catch (error) {
    return oracleError(`the probe threw: ${(error as Error).message}`);
  } finally {
    await stopInstance(ctx, instance);
  }
}
