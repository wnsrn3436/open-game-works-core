import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AutomationResponse } from '../../../../src/commands/instance/automation.ts';
import { OgwError } from '../../../../src/lib/errors.ts';
import { changeRuns, newRunState } from '../../../../src/lib/runstate.ts';

/** A scripted `get_state` answer, or `'error'` for a failed request. */
export type StateStep = { boot_stage?: unknown; user_id?: unknown } | 'error' | 'not-ok';

/**
 * Fake clients of an instance. `get_state` answers the next step of the client's script and repeats
 * the last one. `restart` (the runner's `restartClient`) fails with `restartError` when it is set, and
 * otherwise records the call and returns.
 */
export class FakeClients {
  scripts: Record<string, StateStep[]> = {};
  restartError: string | null = null;
  calls: { instance: string; command: string; client: string }[] = [];

  reset(): void {
    this.scripts = {};
    this.restartError = null;
    this.calls = [];
  }

  request(instance: string, command: string, client = 'main'): Promise<AutomationResponse> {
    this.calls.push({ instance, command, client });
    if (command !== 'get_state') return Promise.reject(new Error(`unexpected command ${command}`));
    const script = this.scripts[client];
    if (!script || script.length === 0) return Promise.reject(new Error(`no client ${client}`));
    const step = (script.length > 1 ? script.shift() : script[0]) as StateStep;
    if (step === 'error') return Promise.reject(new Error('connection closed'));
    if (step === 'not-ok') return Promise.resolve(reply(false, 'busy'));
    return Promise.resolve(reply(true, step));
  }

  restart(instance: string, client = 'main'): Promise<Record<string, unknown>> {
    this.calls.push({ instance, command: 'restart', client });
    if (this.restartError !== null) return Promise.reject(new OgwError(this.restartError));
    return Promise.resolve({ boot_stage: 'Done' });
  }

  commands(): string[] {
    return this.calls.map((call) => `${call.client}:${call.command}`);
  }
}

export function reply(ok: boolean, result: unknown): AutomationResponse {
  return { ok, result, bytes: Buffer.alloc(0), frames: [] };
}

/** Opens a run in the game repo `dir` and writes its `request.md` (when `request` is given). */
export async function openRunWith(dir: string, kind: 'loop' | 'build', name: string, request?: string): Promise<string> {
  const repo = { name: 'g', root: dir, mainRoot: dir, commonDir: join(dir, '.git'), inWorktree: false };
  await changeRuns(repo, (runs) => {
    runs.length = 0;
    runs.push(newRunState({ name, kind, branch: `loop/${name}`, baseCommit: 'abc' }));
  });
  const path = join(dir, 'records', 'loops', name, 'request.md');
  if (request !== undefined) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, request);
  }
  return path;
}

/** Closes every run of the game repo `dir`. */
export async function closeRuns(dir: string): Promise<void> {
  const repo = { name: 'g', root: dir, mainRoot: dir, commonDir: join(dir, '.git'), inWorktree: false };
  await changeRuns(repo, (runs) => {
    runs.length = 0;
  });
}

/** A snapshot JSON text as `export_user_snapshot` sends it. */
export function snapshotText(dataVersion: string, records: unknown[] = [{ table: 'user_state', key: 'a', contract_version: 1, value: 'AA==' }]): string {
  return `{"format":1,"app_id":"com.example.test","source_environment":"PROD","source_user_id":"11","data_version":"${dataVersion}","records":${JSON.stringify(records)},"sha256":"x"}`;
}
