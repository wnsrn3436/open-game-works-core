import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OgwError } from '../../../lib/errors.ts';
import { instanceFolder } from './records.ts';

/**
 * Starts the supervisor of an instance as a detached process in its own process group, so that it
 * outlives `ogw instance start` (and the job that ran it) until `ogw instance stop`.
 */
export async function launchSupervisor(id: string, env: NodeJS.ProcessEnv): Promise<void> {
  const folder = await instanceFolder(id, env);
  mkdirSync(folder, { recursive: true });
  const out = openSync(join(folder, 'supervisor.log'), 'a');
  const entry = join(dirname(fileURLToPath(import.meta.url)), 'supervisor-main.ts');
  const child = spawn(process.execPath, [...process.execArgv, entry, id], {
    cwd: folder,
    env,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  closeSync(out);
  child.unref();
  if (child.pid === undefined) throw new OgwError('cannot start the instance supervisor');
}
