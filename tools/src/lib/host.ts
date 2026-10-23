import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { OgwError } from './errors.ts';
import { LIMITS } from './limits.ts';
import { runOk } from './proc.ts';

/** This host as harness settings `hosts` keys it: the host id and the readable `name`. */
export interface HostIdentity {
  id: string;
  name: string;
}

export interface HostIdOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Linux machine id file. */
  machineIdFile?: string;
}

const HOST_ID = /^[0-9a-f]{32}$/u;

/** A machine identifier in lower case hex without `-`. */
function normalized(raw: string, source: string): string {
  const id = raw.trim().replaceAll('-', '').toLowerCase();
  if (!HOST_ID.test(id)) throw new OgwError(`cannot read the host id: ${source} gave ${JSON.stringify(raw.trim())}`);
  return id;
}

/** The host id of an OS machine identifier: the first 32 hex digits of SHA-256 of `ogw-host:<normalized id>`, so git holds no hardware identifier. */
function toHostId(raw: string, source: string): string {
  return createHash('sha256').update(`ogw-host:${normalized(raw, source)}`).digest('hex').slice(0, 32);
}

async function macosId(env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await runOk('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { env, timeoutMs: LIMITS.shortMs });
  const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/u.exec(stdout);
  if (!match) throw new OgwError('cannot read the host id: ioreg has no IOPlatformUUID');
  return toHostId(match[1] as string, 'IOPlatformUUID');
}

async function linuxId(file: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new OgwError(`cannot read the host id: ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return toHostId(text, file);
}

async function windowsId(env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await runOk('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { env, timeoutMs: LIMITS.shortMs });
  const match = /MachineGuid\s+REG_SZ\s+(\S+)/u.exec(stdout);
  if (!match) throw new OgwError('cannot read the host id: the registry has no MachineGuid');
  return toHostId(match[1] as string, 'MachineGuid');
}

/**
 * The host id ([ogw](../../ogw.md) `## host`) from macOS `IOPlatformUUID`, Linux `/etc/machine-id` or Windows
 * `MachineGuid`. Tests set `OGW_HOST_ID`, which is the host id itself.
 */
export async function resolveHostId(options: HostIdOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const override = env.OGW_HOST_ID;
  if (override !== undefined && override !== '') return normalized(override, 'OGW_HOST_ID');
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') return macosId(env);
  if (platform === 'linux') return linuxId(options.machineIdFile ?? '/etc/machine-id');
  if (platform === 'win32') return windowsId(env);
  throw new OgwError(`cannot read the host id on ${platform}`);
}

/** Host ids by `OGW_HOST_ID` (empty for the OS identifier), read once per process. */
const cache = new Map<string, Promise<string>>();

/** This host: its id (`resolveHostId`, read once per process) and its host name. */
export async function currentHost(env: NodeJS.ProcessEnv = process.env): Promise<HostIdentity> {
  const key = env.OGW_HOST_ID ?? '';
  let id = cache.get(key);
  if (id === undefined) {
    id = resolveHostId({ env });
    cache.set(key, id);
    id.catch(() => cache.delete(key));
  }
  return { id: await id, name: hostname() };
}
