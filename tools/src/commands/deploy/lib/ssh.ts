import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { run, type RunResult } from '../../../lib/proc.ts';
import { newSecretFolder } from '../../../lib/secret-files.ts';

export interface DeployHost {
  host: string;
  hostKey: string;
  user: string;
  dir: string;
  port: number;
}

export interface SshSession {
  /** Runs a shell command on the host. */
  exec(command: string, options?: { input?: string; timeoutMs?: number }): Promise<RunResult>;
  /** Like exec; fails when the command does not end with 0. */
  execOk(command: string, options?: { input?: string; timeoutMs?: number }): Promise<string>;
  close(): Promise<void>;
}

/** Single-quotes a value for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * An SSH session that trusts only `hostKey` (strict host key checking with a known hosts file
 * holding that key alone) and logs in with the private key. The key files live in a new owner-only folder of the
 * secret files folder (`newSecretFolder`), which the play and judge sandbox blocks, and are removed by `close`.
 */
export async function openSsh(target: DeployHost, privateKey: string, env: NodeJS.ProcessEnv): Promise<SshSession> {
  const dir = await newSecretFolder('ogw-ssh-', env);
  const keyFile = join(dir, 'key');
  const knownHosts = join(dir, 'known_hosts');
  await writeFile(keyFile, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, { mode: 0o600 });
  await writeFile(knownHosts, `${target.host} ${target.hostKey}\n`, { mode: 0o600 });
  const base = [
    '-i', keyFile,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'CheckHostIP=no',
    `${target.user}@${target.host}`,
  ];
  const exec: SshSession['exec'] = (command, options = {}) =>
    run('ssh', [...base, command], { env, input: options.input, timeoutMs: options.timeoutMs ?? LIMITS.programMs });
  return {
    exec,
    async execOk(command, options) {
      const result = await exec(command, options);
      if (result.timedOut) throw new OgwError(`ssh: ${command} timed out`);
      if (result.code !== 0) throw new OgwError(`ssh: ${command} failed (${String(result.code)}): ${(result.stderr || result.stdout).trim()}`);
      return result.stdout;
    },
    async close() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
