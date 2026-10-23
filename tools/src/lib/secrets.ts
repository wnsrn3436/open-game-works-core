import { Entry } from '@napi-rs/keyring';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { OgwError } from './errors.ts';
import { LIMITS } from './limits.ts';

/** account name of every ogw secret in the OS credential store */
export const SECRET_ACCOUNT = 'ogw';

export type SecretScope = 'DEV' | 'STG' | 'PROD' | 'signing';

/** service name of a game secret */
export function gameSecretService(game: string, scope: SecretScope, name: string): string {
  return `ogw/${game}/${scope}/${name}`;
}

/** service name of a harness settings secret */
export function harnessSecretService(name: string): string {
  return `ogw/harness/${name}`;
}

export interface SecretStore {
  get(service: string): string | null;
  set(service: string, value: string): void;
  /**
   * Moves the values of `services` that the old store of this host still holds into this store; a store with no old
   * store has none.
   */
  moveOld?(services: readonly string[]): void;
}

/** Entries of a credential store, one value per service, with no size handling. */
export interface SecretEntries {
  get(service: string): string | null;
  set(service: string, value: string): void;
  delete(service: string): void;
}

/**
 * UTF-16 code units per credential entry. Windows Credential Manager holds at most 2560 bytes per credential and
 * keyring stores the value as UTF-16 (1280 code units).
 */
export const SECRET_CHUNK_UNITS = 1000;

const CHUNKED = 'ogw-chunked:';
const CHUNKED_HEAD = /^ogw-chunked:([0-9a-z]+):([1-9][0-9]*)$/;

/** Pieces of at most `size` UTF-16 code units, never splitting a surrogate pair. */
export function splitUnits(value: string, size: number): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const char of value) {
    if (piece.length + char.length > size) {
      pieces.push(piece);
      piece = '';
    }
    piece += char;
  }
  pieces.push(piece);
  return pieces;
}

function chunkService(service: string, id: string, index: number): string {
  return `${service}#${id}-${String(index)}`;
}

function parseHead(service: string, head: string): { id: string; count: number } {
  const match = CHUNKED_HEAD.exec(head);
  if (!match) throw new OgwError(`secret store entry ${service} is not a chunk list`);
  return { id: match[1] as string, count: Number(match[2]) };
}

/**
 * A store over `entries` that keeps a value longer than `size` (or one that starts like a chunk list) in entries
 * `<service>#<id>-<i>`; the entry `<service>` then holds `ogw-chunked:<id>:<count>`. A new value gets a new `<id>`
 * and the head entry is written last, so a failed write leaves the old value readable.
 */
export function chunkedSecretStore(entries: SecretEntries, size = SECRET_CHUNK_UNITS, newChunkId: () => string = randomChunkId): SecretStore {
  return {
    get(service) {
      const head = entries.get(service);
      if (head === null || !head.startsWith(CHUNKED)) return head;
      const { id, count } = parseHead(service, head);
      const parts: string[] = [];
      for (let i = 0; i < count; i++) {
        const part = entries.get(chunkService(service, id, i));
        if (part === null) throw new OgwError(`secret store entry ${chunkService(service, id, i)} is missing`);
        parts.push(part);
      }
      return parts.join('');
    },
    set(service, value) {
      const old = entries.get(service);
      if (value.length <= size && !value.startsWith(CHUNKED)) {
        entries.set(service, value);
      } else {
        const id = newChunkId();
        const parts = splitUnits(value, size);
        parts.forEach((part, i) => {
          entries.set(chunkService(service, id, i), part);
        });
        entries.set(service, `${CHUNKED}${id}:${String(parts.length)}`);
      }
      // The entries of the old value; a broken old chunk list has none to remove.
      const stale = CHUNKED_HEAD.exec(old ?? '');
      if (!stale) return;
      for (let i = 0; i < Number(stale[2]); i++) entries.delete(chunkService(service, stale[1] as string, i));
    },
  };
}

function randomChunkId(): string {
  return randomBytes(6).toString('hex');
}

const keyringEntries: SecretEntries = {
  get(service) {
    try {
      return new Entry(service, SECRET_ACCOUNT).getPassword();
    } catch (error) {
      throw new OgwError(`cannot read secret store: ${(error as Error).message}`);
    }
  },
  set(service, value) {
    try {
      new Entry(service, SECRET_ACCOUNT).setPassword(value);
    } catch (error) {
      throw new OgwError(`cannot write secret store: ${(error as Error).message}`);
    }
  },
  delete(service) {
    try {
      new Entry(service, SECRET_ACCOUNT).deleteCredential();
    } catch (error) {
      throw new OgwError(`cannot write secret store: ${(error as Error).message}`);
    }
  },
};

/** The entries of a chunk list head (`ogw-chunked:<id>:<count>`), or none for a plain value. */
function chunkEntries(service: string, head: string | null): string[] {
  const match = CHUNKED_HEAD.exec(head ?? '');
  if (!match) return [];
  return Array.from({ length: Number(match[2]) }, (_, i) => chunkService(service, match[1] as string, i));
}

/** macOS: the folder of the keychain that holds the ogw secrets, apart from the login keychain the agent CLIs use. */
export function ogwKeychainFolder(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), 'Library', 'Keychains', 'ogw');
}

/** macOS: the keychain file of the ogw secrets in `ogwKeychainFolder`. */
export const OGW_KEYCHAIN_FILE = 'ogw.keychain-db';

/** macOS: service name of the ogw keychain password in the login keychain. */
export const KEYCHAIN_PASSWORD_SERVICE = 'ogw/keychain';

/**
 * macOS: UTF-16 code units per ogw keychain entry. `security -i` reads lines of about 4000 bytes, and the value
 * goes in it as hex: 500 units are at most 1500 UTF-8 bytes, 3000 hex digits.
 */
export const KEYCHAIN_CHUNK_UNITS = 500;

interface SecurityRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A `security -i` argument in double quotes; `security` has no escape for these characters. */
function quoted(text: string): string {
  if (/["\\\r\n]/.test(text)) throw new OgwError(`cannot pass to security: ${JSON.stringify(text)}`);
  return `"${text}"`;
}

/** The value of the `password:` line `security find-generic-password -g` writes: quoted text, or hex for other bytes. */
export function parsePasswordLine(stderr: string): string {
  const line = stderr.split('\n').find((text) => text.startsWith('password:'));
  if (line === undefined) throw new OgwError('security printed no password line');
  const rest = line.slice('password:'.length).replace(/^ /, '');
  if (rest === '') return '';
  const hex = /^0x([0-9A-Fa-f]*)(\s|$)/.exec(rest);
  if (hex) return Buffer.from(hex[1] as string, 'hex').toString('utf8');
  if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) return rest.slice(1, -1);
  throw new OgwError('security printed a password line ogw cannot read');
}

/** Runs `fn` while holding a lock folder at `path`; a lock older than the time limit is left over from a crash. */
function withSyncLock<T>(path: string, fn: () => T): T {
  const deadline = Date.now() + LIMITS.shortMs;
  for (;;) {
    try {
      mkdirSync(path);
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      const made = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
      if (Date.now() - made > LIMITS.shortMs) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new OgwError(`lock busy: ${path}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

export interface KeychainOptions {
  /** The keychain file. */
  keychain: string;
  /** The `security` program. */
  security: string;
  /** Where the keychain password is (the login keychain). */
  passwords: SecretEntries;
}

/**
 * macOS: entries in a keychain file of their own, through `security`. The keychain password is random and kept in
 * `passwords`; it goes to `security` on stdin (`security -i`), as does each value (hex). The keychain is made on the
 * first write.
 */
export function keychainEntries(options: KeychainOptions): SecretEntries {
  const { keychain, security } = options;
  const runSecurity = (args: readonly string[], input?: string): SecurityRun => {
    const result = spawnSync(security, args, { input, encoding: 'utf8', timeout: LIMITS.shortMs });
    if (result.error) throw new OgwError(`cannot run ${security}: ${result.error.message}`);
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const interactive = (line: string, what: string): void => {
    const result = runSecurity(['-i'], `${line}\n`);
    if (result.code !== 0) throw new OgwError(`cannot ${what} the ogw keychain ${keychain}: ${result.stderr.trim()}`);
  };
  const unlock = (): void => {
    const password = options.passwords.get(KEYCHAIN_PASSWORD_SERVICE);
    if (password === null) throw new OgwError(`the password of the ogw keychain ${keychain} is not in the login keychain (${KEYCHAIN_PASSWORD_SERVICE})`);
    interactive(`unlock-keychain -p ${quoted(password)} ${quoted(keychain)}`, 'unlock');
  };
  const create = (): void => {
    const folder = dirname(keychain);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    withSyncLock(join(folder, '.create.lock'), () => {
      if (existsSync(keychain)) return;
      const password = randomBytes(32).toString('base64url');
      const made = join(folder, `.new-${String(process.pid)}.keychain-db`);
      rmSync(made, { force: true });
      interactive(`create-keychain -p ${quoted(password)} ${quoted(made)}`, 'create');
      options.passwords.set(KEYCHAIN_PASSWORD_SERVICE, password);
      renameSync(made, keychain);
    });
  };
  /** Unlocks the keychain; without one, makes it when `make` is true, else returns false. */
  const ready = (make: boolean): boolean => {
    if (!existsSync(keychain)) {
      if (!make) return false;
      create();
    }
    unlock();
    return true;
  };
  return {
    get(service) {
      if (!ready(false)) return null;
      const result = runSecurity(['find-generic-password', '-s', service, '-a', SECRET_ACCOUNT, '-g', keychain]);
      if (result.code === SECURITY_NOT_FOUND) return null;
      if (result.code !== 0) throw new OgwError(`cannot read the ogw keychain ${keychain}: ${result.stderr.trim()}`);
      return parsePasswordLine(result.stderr);
    },
    set(service, value) {
      ready(true);
      const hex = Buffer.from(value, 'utf8').toString('hex');
      interactive(`add-generic-password -U -s ${quoted(service)} -a ${SECRET_ACCOUNT} -X ${quoted(hex)} ${quoted(keychain)}`, 'write');
    },
    delete(service) {
      if (!ready(false)) return;
      const result = runSecurity(['delete-generic-password', '-s', service, '-a', SECRET_ACCOUNT, keychain]);
      if (result.code !== 0 && result.code !== SECURITY_NOT_FOUND) {
        throw new OgwError(`cannot write the ogw keychain ${keychain}: ${result.stderr.trim()}`);
      }
    },
  };
}

/** The exit code of `security` for an item that is not there (errSecItemNotFound). */
const SECURITY_NOT_FOUND = 44;

/** The services a marker file of `movingSecretStore` lists; none when it is missing or broken. */
function readMarker(marker: string): string[] {
  try {
    const moved = (JSON.parse(readFileSync(marker, 'utf8')) as { moved?: unknown }).moved;
    return Array.isArray(moved) ? moved.filter((service): service is string => typeof service === 'string') : [];
  } catch {
    return [];
  }
}

function writeMarker(marker: string, services: readonly string[]): void {
  const tmp = `${marker}.tmp-${String(process.pid)}-${randomChunkId()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ moved: [...services].sort() }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, marker);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw new OgwError(`cannot write ${marker}: ${(error as Error).message}`);
  }
}

/**
 * A store over `store` that moves a value it lacks from `legacy` (the entries of `legacyStore`) into it, and removes
 * a value of `legacy` that `store` replaces, so a value stays in one place only. `moveOld` moves the services the
 * marker file `marker` does not list yet, under a lock, and then adds them to it.
 */
export function movingSecretStore(store: SecretStore, legacyStore: SecretStore, legacy: SecretEntries, marker: string): SecretStore {
  const remove = (service: string): void => {
    const head = legacy.get(service);
    if (head === null) return;
    for (const entry of chunkEntries(service, head)) legacy.delete(entry);
    legacy.delete(service);
  };
  const pending = (services: readonly string[]): string[] => {
    const moved = new Set(readMarker(marker));
    return [...new Set(services)].filter((service) => !moved.has(service));
  };
  return {
    get(service) {
      const value = store.get(service);
      if (value !== null) return value;
      const old = legacyStore.get(service);
      if (old === null) return null;
      store.set(service, old);
      remove(service);
      return old;
    },
    set(service, value) {
      store.set(service, value);
      remove(service);
    },
    moveOld(services) {
      if (pending(services).length === 0) return;
      mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
      withSyncLock(`${marker}.lock`, () => {
        const todo = pending(services);
        for (const service of todo) {
          const old = legacyStore.get(service);
          if (old === null) continue;
          // a value already in `store` is newer: a write there removes the old one, unless that removal failed
          if (store.get(service) === null) store.set(service, old);
          remove(service);
        }
        if (todo.length > 0) writeMarker(marker, [...readMarker(marker), ...todo]);
      });
    },
  };
}

/** The file name of the marker of `movingSecretStore` in the folder of the ogw secret store. */
export const MOVED_MARKER_FILE = 'moved.json';

/** Linux: the folder of the ogw secrets, `$XDG_DATA_HOME/ogw/secrets/` (default `~/.local/share/ogw/secrets/`). */
export function linuxSecretsFolder(env: NodeJS.ProcessEnv = process.env): string {
  const data = env.XDG_DATA_HOME !== undefined && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(env.HOME ?? homedir(), '.local', 'share');
  return join(data, 'ogw', 'secrets');
}

/** The folders of the ogw secret store that the play and judge sandbox blocks: both store folders on macOS. */
export function secretStoreFolders(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') return [ogwKeychainFolder(env), linuxSecretsFolder(env)];
  if (platform === 'linux') return [linuxSecretsFolder(env)];
  return [];
}

/** The file of `service` in a folder store: the service name URI-encoded, with `.` encoded too. */
function serviceFile(folder: string, service: string): string {
  return join(folder, encodeURIComponent(service).replaceAll('.', '%2E'));
}

/**
 * Entries in `folder`, one file per service, that only the owner reads and writes: the folder 0700, each file 0600
 * and written through a temporary file, fsync and a rename.
 */
export function folderSecretEntries(folder: string): SecretEntries {
  const ready = (): void => {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (!lstatSync(folder).isDirectory()) throw new OgwError(`the ogw secret folder ${folder} is not a folder`);
    chmodSync(folder, 0o700);
  };
  const failed = (what: string, error: unknown): OgwError => new OgwError(`cannot ${what} secret store ${folder}: ${(error as Error).message}`);
  return {
    get(service) {
      try {
        return readFileSync(serviceFile(folder, service), 'utf8');
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return null;
        throw failed('read', error);
      }
    },
    set(service, value) {
      const tmp = join(folder, `.tmp-${String(process.pid)}-${randomChunkId()}`);
      try {
        ready();
        const fd = openSync(tmp, 'wx', 0o600);
        try {
          writeSync(fd, value, null, 'utf8');
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, serviceFile(folder, service));
      } catch (error) {
        try {
          rmSync(tmp, { force: true });
        } catch {
          // no temporary file where the folder is missing or not a folder
        }
        throw error instanceof OgwError ? error : failed('write', error);
      }
    },
    delete(service) {
      try {
        rmSync(serviceFile(folder, service), { force: true });
      } catch (error) {
        throw failed('write', error);
      }
    },
  };
}

/**
 * Entries over `entries` that read a store ogw cannot reach (no D-Bus session bus, no Secret Service) as empty: the
 * Linux Secret Service, where ogw only moves old values from.
 */
function unreachableAsEmpty(entries: SecretEntries): SecretEntries {
  return {
    get(service) {
      try {
        return entries.get(service);
      } catch {
        return null;
      }
    },
    set: (service, value) => {
      entries.set(service, value);
    },
    delete: (service) => {
      entries.delete(service);
    },
  };
}

/**
 * Linux: the store in `folder` (`folderSecretEntries`) that takes the values still in the Secret Service
 * (`secretService`, read as empty when ogw cannot reach it) as `movingSecretStore` does.
 */
export function linuxSecretStore(folder: string, secretService: SecretEntries): SecretStore {
  const old = unreachableAsEmpty(secretService);
  return movingSecretStore(folderSecretEntries(folder), chunkedSecretStore(old), old, join(folder, MOVED_MARKER_FILE));
}

/**
 * The secret store of ogw (`tools/ogw.md` `## secret store`). macOS: the ogw keychain (`ogwKeychainFolder`).
 * Linux: the folder `linuxSecretsFolder`; ogw does not use the Secret Service. Both block in the play and judge
 * sandbox, and take the values still in the old store (the login keychain, the Secret Service) as `movingSecretStore`
 * does. Other OS: the OS credential store (Windows Credential Manager).
 */
export function osSecretStore(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): SecretStore {
  const login = chunkedSecretStore(keyringEntries);
  if (platform === 'linux') return linuxSecretStore(linuxSecretsFolder(env), keyringEntries);
  if (platform !== 'darwin') return login;
  const folder = ogwKeychainFolder(env);
  const ogw = chunkedSecretStore(
    keychainEntries({ keychain: join(folder, OGW_KEYCHAIN_FILE), security: '/usr/bin/security', passwords: keyringEntries }),
    KEYCHAIN_CHUNK_UNITS,
  );
  return movingSecretStore(ogw, login, keyringEntries, join(folder, MOVED_MARKER_FILE));
}

/** A JSON file store used by tests instead of the OS store. */
export function fileSecretStore(path: string): SecretEntries {
  const load = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const save = (all: Record<string, string>): void => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${String(process.pid)}`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(tmp, path);
  };
  return {
    get(service) {
      return load()[service] ?? null;
    },
    set(service, value) {
      save({ ...load(), [service]: value });
    },
    delete(service) {
      const all = load();
      if (!(service in all)) return;
      save(Object.fromEntries(Object.entries(all).filter(([key]) => key !== service)));
    },
  };
}

/**
 * Tests set `OGW_TEST_SECRET_FILE` to keep secrets out of the OS store, and `OGW_TEST_OLD_SECRET_FILE` for an old
 * store that values move from as from the login keychain (marker `<OGW_TEST_SECRET_FILE>.moved.json`).
 */
export function secretStore(env: NodeJS.ProcessEnv = process.env): SecretStore {
  const file = env.OGW_TEST_SECRET_FILE;
  if (!file) return osSecretStore(env);
  const old = env.OGW_TEST_OLD_SECRET_FILE;
  if (!old) return fileSecretStore(file);
  const oldEntries = fileSecretStore(old);
  return movingSecretStore(fileSecretStore(file), oldEntries, oldEntries, `${file}.moved.json`);
}
