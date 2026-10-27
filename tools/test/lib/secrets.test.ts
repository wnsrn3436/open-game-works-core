import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { makeBlocked, sandboxed } from '../../src/commands/agent/lib/cli-command.ts';
import { newTempFolder } from '../../src/commands/agent/lib/files.ts';
import {
  chunkedSecretStore,
  OGW_KEYCHAIN_FILE,
  folderSecretEntries,
  keychainEntries,
  linuxSecretsFolder,
  linuxSecretStore,
  MOVED_MARKER_FILE,
  KEYCHAIN_CHUNK_UNITS,
  KEYCHAIN_PASSWORD_SERVICE,
  movingSecretStore,
  parsePasswordLine,
  secretStoreFolders,
  SECRET_CHUNK_UNITS,
  splitUnits,
  type SecretEntries,
} from '../../src/lib/secrets.ts';
import { readAll } from '../../src/lib/stdin.ts';

/** In-memory entries that refuse a value over 1280 UTF-16 code units, like Windows Credential Manager (2560 bytes). */
function windowsLike(): SecretEntries & { map: Map<string, string>; deleted: string[] } {
  const map = new Map<string, string>();
  const deleted: string[] = [];
  return {
    map,
    deleted,
    get: (service) => map.get(service) ?? null,
    set: (service, value) => {
      if (value.length > 1280) throw new Error('blob too large');
      map.set(service, value);
    },
    delete: (service) => {
      deleted.push(service);
      map.delete(service);
    },
  };
}

function ids(): () => string {
  let n = 0;
  return () => `id${String(++n)}`;
}

describe('chunkedSecretStore', () => {
  it('stores a 20000-character value in entries the Windows store accepts and reads it back', () => {
    const entries = windowsLike();
    const store = chunkedSecretStore(entries, SECRET_CHUNK_UNITS, ids());
    const value = 'k'.repeat(19_999) + '\n';
    store.set('ogw/g/signing/keystore', value);
    expect(store.get('ogw/g/signing/keystore')).toBe(value);
    expect(entries.map.get('ogw/g/signing/keystore')).toBe('ogw-chunked:id1:20');
    expect(entries.map.get('ogw/g/signing/keystore#id1-0')).toBe('k'.repeat(1000));
    expect(entries.map.get('ogw/g/signing/keystore#id1-19')).toBe(`${'k'.repeat(999)}\n`);
    expect(entries.map.size).toBe(21);
  });

  it('keeps a short value in one entry and a value of exactly the chunk size too', () => {
    const entries = windowsLike();
    const store = chunkedSecretStore(entries, 4, ids());
    store.set('s', 'abcd');
    expect([...entries.map]).toEqual([['s', 'abcd']]);
    expect(store.get('s')).toBe('abcd');
    store.set('s', 'abcde');
    expect(Object.fromEntries(entries.map)).toEqual({ s: 'ogw-chunked:id1:2', 's#id1-0': 'abcd', 's#id1-1': 'e' });
    expect(store.get('missing')).toBeNull();
  });

  it('removes the entries of the old value when it is replaced', () => {
    const entries = windowsLike();
    const store = chunkedSecretStore(entries, 2, ids());
    store.set('s', 'abcde');
    store.set('s', 'xyz');
    expect(entries.deleted).toEqual(['s#id1-0', 's#id1-1', 's#id1-2']);
    expect(Object.fromEntries(entries.map)).toEqual({ s: 'ogw-chunked:id2:2', 's#id2-0': 'xy', 's#id2-1': 'z' });
    store.set('s', 'q');
    expect([...entries.map]).toEqual([['s', 'q']]);
    expect(store.get('s')).toBe('q');
  });

  it('keeps the old value readable when writing a new one fails', () => {
    const entries = windowsLike();
    const store = chunkedSecretStore(entries, 2, ids());
    store.set('s', 'abc');
    let calls = 0;
    const set = (service: string, value: string): void => {
      calls += 1;
      if (calls === 2) throw new Error('full');
      entries.set(service, value);
    };
    const failing = chunkedSecretStore({ ...entries, set }, 2, () => 'new');
    expect(() => {
      failing.set('s', 'wxyz');
    }).toThrow('full');
    expect(store.get('s')).toBe('abc');
  });

  it('chunks a short value that looks like a chunk list, so it reads back as itself', () => {
    const entries = windowsLike();
    const store = chunkedSecretStore(entries, SECRET_CHUNK_UNITS, ids());
    store.set('s', 'ogw-chunked:x:1');
    expect(entries.map.get('s')).toBe('ogw-chunked:id1:1');
    expect(store.get('s')).toBe('ogw-chunked:x:1');
  });

  it('fails on a broken chunk list', () => {
    const entries = windowsLike();
    const store = chunkedSecretStore(entries, 2, ids());
    entries.map.set('s', 'ogw-chunked:bad');
    expect(() => store.get('s')).toThrow('secret store entry s is not a chunk list');
    entries.map.set('s', 'ogw-chunked:ab:0');
    expect(() => store.get('s')).toThrow('secret store entry s is not a chunk list');
    entries.map.set('s', 'ogw-chunked:ab:2');
    entries.map.set('s#ab-0', 'x');
    expect(() => store.get('s')).toThrow('secret store entry s#ab-1 is missing');
    entries.map.set('s', 'ogw-chunked:bad');
    store.set('s', 'y');
    expect(store.get('s')).toBe('y');
    expect(entries.deleted).toEqual([]);
  });
});

describe('splitUnits', () => {
  it('splits by UTF-16 code units without breaking a surrogate pair', () => {
    expect(splitUnits('abcdef', 4)).toEqual(['abcd', 'ef']);
    expect(splitUnits('abc\u{1F600}d', 4)).toEqual(['abc', '\u{1F600}d']);
    expect(splitUnits('', 4)).toEqual(['']);
    expect(splitUnits('abcd', 4)).toEqual(['abcd']);
  });
});

describe('readAll', () => {
  it('reads a terminal until EOF instead of taking it as empty', async () => {
    const tty = Object.assign(Readable.from([Buffer.from('typed '), 'value\n']), { isTTY: true });
    expect(await readAll(tty)).toBe('typed value\n');
    expect(await readAll(Readable.from([]))).toBe('');
  });
});

/**
 * A fake `security` over a JSON keychain file `{ password, unlocked, items }`: `-i` with `create-keychain`,
 * `unlock-keychain`, `add-generic-password -X`; `find-generic-password -g` and `delete-generic-password`. It reads
 * no item of a locked keychain, takes lines of at most 4000 bytes as `security -i` does, prints a value as quoted
 * text or as hex as `security` does, and records every argv.
 */
async function fakeSecurity(): Promise<{ security: string; calls: () => string[][] }> {
  const dir = await newTempFolder('ogw-fake-security-');
  const calls = join(dir, 'calls.jsonl');
  writeFileSync(calls, '');
  const script = join(dir, 'security.mjs');
  writeFileSync(
    script,
    `
import * as fs from 'node:fs';
const calls = ${JSON.stringify(calls)};
const load = (path) => JSON.parse(fs.readFileSync(path, 'utf8'));
const save = (path, kc) => fs.writeFileSync(path, JSON.stringify(kc));
const tokens = (line) => [...line.matchAll(/"([^"]*)"|(\\S+)/g)].map((m) => m[1] ?? m[2]);
const opt = (args, name) => args[args.indexOf(name) + 1];
const run = (args) => {
  const [command, ...rest] = args;
  const path = rest[rest.length - 1];
  if (command === 'create-keychain') { save(path, { password: opt(rest, '-p'), unlocked: true, items: {} }); return 0; }
  if (!fs.existsSync(path)) { process.stderr.write('no keychain\\n'); return 50; }
  const kc = load(path);
  if (command === 'unlock-keychain') {
    if (opt(rest, '-p') !== kc.password) { process.stderr.write('wrong password\\n'); return 51; }
    kc.unlocked = true; save(path, kc); return 0;
  }
  if (!kc.unlocked) { process.stderr.write('locked\\n'); return 52; }
  const key = opt(rest, '-s') + '|' + opt(rest, '-a');
  if (command === 'add-generic-password') { kc.items[key] = opt(rest, '-X'); save(path, kc); return 0; }
  if (!(key in kc.items)) { process.stderr.write('could not be found\\n'); return 44; }
  if (command === 'delete-generic-password') { delete kc.items[key]; save(path, kc); return 0; }
  const value = Buffer.from(kc.items[key], 'hex');
  const printable = [...value].every((b) => b >= 0x20 && b < 0x7f);
  process.stdout.write('keychain: "' + path + '"\\n');
  process.stderr.write(value.length === 0 ? 'password: \\n' : printable ? 'password: "' + value.toString() + '"\\n' : 'password: 0x' + value.toString('hex').toUpperCase() + '  "..."\\n');
  return 0;
};
const argv = process.argv.slice(2);
fs.appendFileSync(calls, JSON.stringify(argv) + '\\n');
let code = 0;
if (argv[0] === '-i') {
  for (const line of fs.readFileSync(0, 'utf8').split('\\n').filter((l) => l !== '')) code = Buffer.byteLength(line) > 4000 ? 1 : run(tokens(line));
} else code = run(argv);
process.exitCode = code;
`,
  );
  const security = join(dir, 'security');
  writeFileSync(security, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(security, 0o755);
  return {
    security,
    calls: () =>
      readFileSync(calls, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as string[]),
  };
}

function memoryEntries(): SecretEntries & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (service) => map.get(service) ?? null,
    set: (service, value) => {
      map.set(service, value);
    },
    delete: (service) => {
      map.delete(service);
    },
  };
}

describe('ogw keychain (macOS)', () => {
  it('makes the keychain on the first write with a random password, and passes the password and the values only on stdin', async () => {
    const fake = await fakeSecurity();
    const keychain = join(await newTempFolder('ogw-home-'), 'Library Keychains', 'ogw', 'ogw.keychain-db');
    const passwords = memoryEntries();
    const store = chunkedSecretStore(keychainEntries({ keychain, security: fake.security, passwords }), KEYCHAIN_CHUNK_UNITS);
    expect(store.get('ogw/g/DEV/a')).toBeNull();
    expect(existsSync(keychain)).toBe(false);
    const values = ['plain', '414243', 'a "quoted" b', 'line\n é 한글 \u{1F600}', `${'x'.repeat(3000)}${'한'.repeat(900)}`, ''];
    values.forEach((value, i) => {
      store.set(`ogw/g/DEV/s${String(i)}`, value);
    });
    const password = passwords.map.get(KEYCHAIN_PASSWORD_SERVICE) as string;
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(existsSync(keychain)).toBe(true);
    values.forEach((value, i) => {
      expect(store.get(`ogw/g/DEV/s${String(i)}`)).toBe(value);
    });
    for (const argv of fake.calls()) {
      expect(argv.join(' ')).not.toContain(password);
      expect(argv.join(' ')).not.toContain('plain');
    }
    // relocked: every access unlocks first
    const kc = JSON.parse(readFileSync(keychain, 'utf8')) as { unlocked: boolean };
    kc.unlocked = false;
    writeFileSync(keychain, JSON.stringify(kc));
    expect(store.get('ogw/g/DEV/s0')).toBe('plain');
  });

  it('deletes an entry, fails without the keychain password, and refuses text security cannot take', async () => {
    const fake = await fakeSecurity();
    const keychain = join(await newTempFolder('ogw-home-'), 'ogw', 'ogw.keychain-db');
    const passwords = memoryEntries();
    const entries = keychainEntries({ keychain, security: fake.security, passwords });
    entries.delete('s');
    entries.set('s', 'v');
    entries.delete('s');
    entries.delete('s');
    expect(entries.get('s')).toBeNull();
    expect(() => {
      entries.set('a"b', 'v');
    }).toThrow('cannot pass to security');
    passwords.map.clear();
    expect(() => entries.get('s')).toThrow(`is not in the login keychain (${KEYCHAIN_PASSWORD_SERVICE})`);
    passwords.map.set(KEYCHAIN_PASSWORD_SERVICE, 'wrong');
    expect(() => entries.get('s')).toThrow('cannot unlock the ogw keychain');
  });

  it('reads the password line of security as quoted text or hex', () => {
    expect(parsePasswordLine('password: "a "b" c"\n')).toBe('a "b" c');
    expect(parsePasswordLine('x\npassword: 0x61206222630AC3A9  "a b"c\\012\\303\\251"\n')).toBe('a b"c\né');
    expect(parsePasswordLine('password: \n')).toBe('');
    expect(() => parsePasswordLine('nothing\n')).toThrow('no password line');
  });
});

describe('movingSecretStore', () => {
  it('moves a value only the login keychain has into the ogw keychain, with its chunks, and removes it there on a write', async () => {
    const dir = await newTempFolder('ogw-moving-');
    const ogw = memoryEntries();
    const login = memoryEntries();
    const loginStore = chunkedSecretStore(login, 2, ids());
    loginStore.set('a', 'abcde');
    loginStore.set('b', 'old');
    const store = movingSecretStore(chunkedSecretStore(ogw, 100), loginStore, login, join(dir, MOVED_MARKER_FILE));
    expect(store.get('a')).toBe('abcde');
    expect(ogw.map.get('a')).toBe('abcde');
    expect(store.get('a')).toBe('abcde');
    store.set('b', 'new');
    expect(store.get('b')).toBe('new');
    expect(store.get('c')).toBeNull();
    expect([...login.map]).toEqual([]);
  });

  it('reads the login keychain no more once the marker has done true', async () => {
    const dir = await newTempFolder('ogw-moving-');
    const ogw = memoryEntries();
    const login = memoryEntries();
    const seen = counted(login);
    const store = movingSecretStore(ogw, seen, seen, join(dir, MOVED_MARKER_FILE));
    store.moveOld?.(['a']);
    const reads = seen.reads();
    // a value planted later, e.g. by an agent in the play and judge sandbox, which may write the login keychain
    login.set('ogw/g/PROD/accessTokenKey', 'planted');
    expect(store.get('ogw/g/PROD/accessTokenKey')).toBeNull();
    store.moveOld?.(['ogw/g/PROD/accessTokenKey']);
    store.set('b', 'v');
    expect(seen.reads()).toBe(reads);
    expect(ogw.map.has('ogw/g/PROD/accessTokenKey')).toBe(false);
    // another process sees the mark in the file
    const other = movingSecretStore(ogw, seen, seen, join(dir, MOVED_MARKER_FILE));
    expect(other.get('ogw/g/PROD/accessTokenKey')).toBeNull();
    other.moveOld?.(['c']);
    expect(seen.reads()).toBe(reads);
  });
});

/** Entries that count their reads, over `entries`. */
function counted(entries: SecretEntries): SecretEntries & { reads: () => number } {
  let reads = 0;
  return {
    reads: () => reads,
    get: (service) => {
      reads++;
      return entries.get(service);
    },
    set: (service, value) => {
      entries.set(service, value);
    },
    delete: (service) => {
      entries.delete(service);
    },
  };
}

describe('movingSecretStore moveOld', () => {
  it('moves every named value from the login keychain into the ogw keychain once, and never again', async () => {
    const fake = await fakeSecurity();
    const folder = join(await newTempFolder('ogw-home-'), 'ogw');
    const keychain = join(folder, OGW_KEYCHAIN_FILE);
    const login = memoryEntries();
    const loginStore = chunkedSecretStore(login, 4, ids());
    // values only build and deploy read: never read before a play or judge agent starts
    loginStore.set('ogw/g/PROD/deploySsh', 'ssh-key-value');
    loginStore.set('ogw/g/DEV/db', 'db');
    loginStore.set('ogw/harness/key', 'harness');
    loginStore.set('ogw/other/DEV/x', 'not named');
    const seen = counted(login);
    const ogw = chunkedSecretStore(keychainEntries({ keychain, security: fake.security, passwords: login }), KEYCHAIN_CHUNK_UNITS);
    const store = movingSecretStore(ogw, chunkedSecretStore(seen), seen, join(folder, MOVED_MARKER_FILE));
    const named = ['ogw/g/PROD/deploySsh', 'ogw/g/DEV/db', 'ogw/harness/key', 'ogw/g/DEV/none'];
    store.moveOld?.(named);
    expect(existsSync(keychain)).toBe(true);
    expect(ogw.get('ogw/g/PROD/deploySsh')).toBe('ssh-key-value');
    expect(ogw.get('ogw/g/DEV/db')).toBe('db');
    expect(ogw.get('ogw/harness/key')).toBe('harness');
    expect(ogw.get('ogw/g/DEV/none')).toBeNull();
    // the chunks go too; the login keychain keeps only the keychain password and the name nothing named
    expect([...login.map.keys()].sort()).toEqual([KEYCHAIN_PASSWORD_SERVICE, 'ogw/other/DEV/x', 'ogw/other/DEV/x#id3-0', 'ogw/other/DEV/x#id3-1', 'ogw/other/DEV/x#id3-2']);
    expect(JSON.parse(readFileSync(join(folder, MOVED_MARKER_FILE), 'utf8'))).toEqual({ moved: [...named].sort(), done: true });
    // no read of either keychain afterwards, not even for a new name
    const reads = seen.reads();
    const calls = fake.calls().length;
    store.moveOld?.(named);
    store.moveOld?.([...named, 'ogw/other/DEV/x']);
    expect(seen.reads()).toBe(reads);
    expect(fake.calls().length).toBe(calls);
    expect(login.map.has('ogw/other/DEV/x')).toBe(true);
    expect(ogw.get('ogw/other/DEV/x')).toBeNull();
    expect(readdirSync(folder).filter((name) => name.includes('lock') || name.includes('tmp'))).toEqual([]);
  });

  it('moves the names a marker without done true lacks, then marks it done', async () => {
    const dir = await newTempFolder('ogw-moving-');
    const ogw = memoryEntries();
    const login = memoryEntries();
    login.set('a', 'moved before');
    login.set('b', 'new name');
    const marker = join(dir, MOVED_MARKER_FILE);
    writeFileSync(marker, JSON.stringify({ moved: ['a'] }));
    const store = movingSecretStore(ogw, login, login, marker);
    store.moveOld?.(['a', 'b']);
    expect(ogw.map.get('b')).toBe('new name');
    expect(ogw.map.has('a')).toBe(false);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ moved: ['a', 'b'], done: true });
  });

  it('keeps the value already in the store and still removes the old one', async () => {
    const dir = await newTempFolder('ogw-moving-');
    const ogw = memoryEntries();
    const login = memoryEntries();
    ogw.set('a', 'new');
    login.set('a', 'old');
    const store = movingSecretStore(ogw, login, login, join(dir, MOVED_MARKER_FILE));
    store.moveOld?.(['a']);
    expect(store.get('a')).toBe('new');
    expect(login.map.has('a')).toBe(false);
  });
});

describe('Linux secret store', () => {
  it('is $XDG_DATA_HOME/ogw/secrets, else ~/.local/share/ogw/secrets, and the sandbox blocks it', () => {
    expect(linuxSecretsFolder({ HOME: '/h', XDG_DATA_HOME: '/d' })).toBe('/d/ogw/secrets');
    expect(linuxSecretsFolder({ HOME: '/h' })).toBe('/h/.local/share/ogw/secrets');
    expect(linuxSecretsFolder({ HOME: '/h', XDG_DATA_HOME: 'rel' })).toBe('/h/.local/share/ogw/secrets');
    expect(secretStoreFolders({ HOME: '/h' }, 'linux')).toEqual(['/h/.local/share/ogw/secrets']);
    expect(secretStoreFolders({ HOME: '/h' }, 'darwin')).toEqual(['/h/Library/Keychains/ogw', '/h/.local/share/ogw/secrets']);
    expect(secretStoreFolders({ HOME: '/h' }, 'win32')).toEqual([]);
  });

  it('keeps one 0600 file per secret in a 0700 folder, written by rename, and reads a missing one as null', async () => {
    const folder = join(await newTempFolder('ogw-data-'), 'ogw', 'secrets');
    const entries = folderSecretEntries(folder);
    expect(entries.get('ogw/g/DEV/db')).toBeNull();
    expect(existsSync(folder)).toBe(false);
    entries.delete('ogw/g/DEV/db');
    const values = ['plain', 'line\n é 한글 \u{1F600}', 'x'.repeat(100_000), ''];
    values.forEach((value, i) => {
      entries.set(`ogw/g/DEV/s${String(i)}`, value);
    });
    values.forEach((value, i) => {
      expect(entries.get(`ogw/g/DEV/s${String(i)}`)).toBe(value);
    });
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    const files = readdirSync(folder).sort();
    expect(files).toEqual(values.map((_, i) => `ogw%2Fg%2FDEV%2Fs${String(i)}`).sort());
    for (const name of files) expect(statSync(join(folder, name)).mode & 0o777).toBe(0o600);
    // a new value is a new file renamed over the old one, never the old file written in place
    const file = join(folder, 'ogw%2Fg%2FDEV%2Fs0');
    const before = statSync(file).ino;
    entries.set('ogw/g/DEV/s0', 'changed');
    expect(statSync(file).ino).not.toBe(before);
    expect(entries.get('ogw/g/DEV/s0')).toBe('changed');
    entries.delete('ogw/g/DEV/s0');
    expect(entries.get('ogw/g/DEV/s0')).toBeNull();
    expect(existsSync(file)).toBe(false);
    // a dot name stays in the folder
    entries.set('..', 'dots');
    expect(readdirSync(folder)).toContain('%2E%2E');
    // a folder made open to others becomes 0700 on the next write
    chmodSync(folder, 0o755);
    entries.set('ogw/g/DEV/s1', 'again');
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(readdirSync(folder).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
  });

  it('fails to write where the folder is a file', async () => {
    const folder = join(await newTempFolder('ogw-data-'), 'secrets');
    writeFileSync(folder, 'file');
    const entries = folderSecretEntries(folder);
    expect(() => {
      entries.set('a', 'v');
    }).toThrow('cannot write secret store');
    expect(() => entries.get('a')).toThrow('cannot read secret store');
  });

  it('moves the named values of the Secret Service into the folder once, and reads an unreachable Secret Service as empty', async () => {
    const folder = join(await newTempFolder('ogw-data-'), 'ogw', 'secrets');
    const secretService = memoryEntries();
    chunkedSecretStore(secretService, 3, ids()).set('ogw/g/STG/key', 'chunked value');
    secretService.set('ogw/harness/k', 'h');
    const store = linuxSecretStore(folder, secretService);
    store.moveOld?.(['ogw/g/STG/key', 'ogw/harness/k']);
    expect([...secretService.map.keys()]).toEqual([]);
    expect(folderSecretEntries(folder).get('ogw/g/STG/key')).toBe('chunked value');
    expect(store.get('ogw/harness/k')).toBe('h');
    expect(readdirSync(folder).sort()).toEqual([MOVED_MARKER_FILE, 'ogw%2Fg%2FSTG%2Fkey', 'ogw%2Fharness%2Fk']);
    expect(statSync(join(folder, MOVED_MARKER_FILE)).mode & 0o777).toBe(0o600);
    // a value put there later is not read
    secretService.set('ogw/g/DEV/late', 'late');
    expect(store.get('ogw/g/DEV/late')).toBeNull();
    expect(secretService.map.has('ogw/g/DEV/late')).toBe(true);
    // no D-Bus session bus or no Secret Service
    const unreachable: SecretEntries = {
      get: () => {
        throw new Error('Platform secure storage failure: no session bus');
      },
      set: () => undefined,
      delete: () => undefined,
    };
    const headless = linuxSecretStore(join(await newTempFolder('ogw-data-'), 'secrets'), unreachable);
    expect(headless.get('ogw/g/DEV/x')).toBeNull();
    headless.moveOld?.(['ogw/g/DEV/x']);
    headless.set('ogw/g/DEV/x', 'v');
    expect(headless.get('ogw/g/DEV/x')).toBe('v');
  });
});

describe('Linux sandbox', () => {
  it('blocks the Linux secret store folder for reading and writing with an empty tmpfs', async () => {
    const home = await newTempFolder('ogw-home-');
    const folder = linuxSecretsFolder({ HOME: home });
    const blocked = { folders: secretStoreFolders({ HOME: home }, 'linux'), files: [] };
    makeBlocked(blocked, 'linux');
    expect(existsSync(folder)).toBe(true);
    const { args } = sandboxed({ cmd: 'claude', args: [] }, blocked, { platform: 'linux' });
    const at = args.indexOf(realpathSync(folder));
    expect(at).toBeGreaterThan(0);
    expect(args[at - 1]).toBe('--tmpfs');
  });
});
