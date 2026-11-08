import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMPORT_CACHE, importKey, importThroughCache } from '../../../src/commands/instance/lib/import-cache.ts';
import { listRecords, readRecord } from '../../../src/commands/instance/lib/records.ts';
import { ogw, sh } from '../../helpers/workspace.ts';
import { mockState } from './mocks/state.ts';
import { setupRunner, startFor, stopAll, type Runner } from './runner.ts';

vi.mock('../../../src/commands/generate/api.ts', async () => (await import('./mocks/apis.ts')).generate);
vi.mock('../../../src/commands/data/api.ts', async () => (await import('./mocks/apis.ts')).data);
vi.mock('../../../src/commands/core/api.ts', async () => (await import('./mocks/apis.ts')).core);
vi.mock('../../../src/commands/env/api.ts', async () => (await import('./mocks/apis.ts')).env);
vi.mock('../../../src/commands/instance/lib/spawn.ts', () => import('./mocks/spawn.ts'));
vi.mock('../../../src/commands/instance/lib/launch.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/commands/instance/lib/launch.ts')>();
  return { ...real, ...(await import('./mocks/apis.ts')).launchOverrides(real) };
});

/** Holds the removal of the import cache entry `entry` (a key) until `hold` resolves; reset after each test. */
const removal = vi.hoisted(() => ({ entry: null as string | null, hold: null as Promise<void> | null, held: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rm: async (...args: Parameters<typeof real.rm>) => {
      if (removal.entry !== null && removal.hold !== null && String(args[0]).endsWith(`${IMPORT_CACHE}/${removal.entry}`)) {
        removal.held = true;
        await removal.hold;
      }
      return real.rm(...args);
    },
  };
});

let runner: Runner | null = null;

afterEach(async () => {
  removal.entry = null;
  removal.hold = null;
  removal.held = false;
  if (runner) await stopAll(runner);
  runner = null;
});

/** A game whose Godot project has a script and a resource linked into it, as `ogw generate` links `resource/`. */
function gameRunner(harness: Record<string, unknown> = {}): Runner {
  const r = setupRunner({ files: { 'client/main.gd': 'extends Node\n', 'resource/a.png': 'png', 'resource/a.png.import': '[remap]\n' }, harness });
  symlinkSync('../resource', join(r.root, 'client', 'resource'));
  sh(r.root, 'git', ['add', '-A']);
  sh(r.root, 'git', ['commit', '-q', '-m', 'link']);
  r.ws.env.FAKE_IMPORT_PRODUCTS = '1';
  return r;
}

/** Every file under `client/` and `resource/` of a checkout, `client/.godot/` included: its content, or `-> <target>` for a link. */
function filesOf(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const at = join(rel, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) files[at] = `-> ${readlinkSync(path)}`;
      else if (info.isDirectory()) walk(path, at);
      else files[at] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  for (const top of ['client', 'resource']) walk(join(root, top), top);
  return files;
}

function imports(r: Runner): number {
  const log = join(r.logDir, 'import.log');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0;
}

/** The files of the checkout of a started instance. */
async function checkoutFiles(r: Runner, id: string): Promise<Record<string, string>> {
  return filesOf((await readRecord(id, r.ws.env)).root);
}

function entries(r: Runner): string[] {
  const dir = join(r.root, '.git', IMPORT_CACHE);
  return existsSync(dir) ? readdirSync(dir).filter((n) => /^[0-9a-f]{64}$/.test(n)) : [];
}

describe('ogw instance start: import cache', () => {
  it('gives the next --commit checkout of the same files a copy of the import, with the same files and no import', async () => {
    runner = gameRunner();
    const sha = sh(runner.root, 'git', ['rev-parse', 'HEAD']).trim();
    const first = await startFor(runner, ['--commit', sha]);
    expect(imports(runner)).toBe(1);
    const imported = await checkoutFiles(runner, first);
    // the import wrote files outside client/.godot/ too: a .uid file, and the .import file of the linked resource again
    expect(Object.keys(imported)).toContain('client/main.gd.uid');
    expect(Object.keys(imported).filter((p) => p.startsWith('client/.godot/'))).toContain('client/.godot/uid_cache.bin');
    await ogw(runner.ws, ['instance', 'stop', first]);
    const second = await startFor(runner, ['--commit', sha]);
    expect(imports(runner)).toBe(1);
    // the same files as the checkout of the import: the random uid and uid cache too, and the link as it is
    expect(await checkoutFiles(runner, second)).toEqual(imported);
    expect(entries(runner)).toHaveLength(1);
  });

  it('imports a checkout whose files differ itself: another commit never takes the import of a commit', async () => {
    runner = gameRunner();
    const sha = sh(runner.root, 'git', ['rev-parse', 'HEAD']).trim();
    const first = await startFor(runner, ['--commit', sha]);
    const imported = await checkoutFiles(runner, first);
    writeFileSync(join(runner.root, 'resource', 'a.png'), 'png 2');
    sh(runner.root, 'git', ['commit', '-q', '-am', 'resource']);
    const next = sh(runner.root, 'git', ['rev-parse', 'HEAD']).trim();
    const other = await startFor(runner, ['--commit', next]);
    expect(imports(runner)).toBe(2);
    const own = await checkoutFiles(runner, other);
    expect(own['client/.godot/imported/resource_a.png.md5']).not.toBe(imported['client/.godot/imported/resource_a.png.md5']);
    expect(own['client/.godot/uid_cache.bin']).not.toBe(imported['client/.godot/uid_cache.bin']);
    expect(entries(runner)).toHaveLength(2);
    // a checkout of the same commit with a file that differs from the commit is no checkout of that commit's import
    const root = (await readRecord(other, runner.ws.env)).root;
    const key = await importKey(root, mockState.enginePath);
    writeFileSync(join(root, 'client', 'main.gd'), 'extends Node2D\n');
    expect(await importKey(root, mockState.enginePath)).not.toBe(key);
  });

  it('imports once when the starts of one commit run together; the others wait for its import and copy it', async () => {
    runner = gameRunner();
    const sha = sh(runner.root, 'git', ['rev-parse', 'HEAD']).trim();
    const ids = await Promise.all([startFor(runner, ['--commit', sha]), startFor(runner, ['--commit', sha]), startFor(runner, ['--commit', sha])]);
    expect(imports(runner)).toBe(1);
    const [a, b, c] = await Promise.all(ids.map((id) => checkoutFiles(runner as Runner, id)));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('keeps the maxConcurrentInstances entries used last and a failed import none, and imports a checkout without --commit itself', async () => {
    runner = gameRunner({ maxConcurrentInstances: 2 });
    const commits: string[] = [];
    for (const n of [1, 2, 3]) {
      writeFileSync(join(runner.root, 'client', 'main.gd'), `extends Node # ${String(n)}\n`);
      sh(runner.root, 'git', ['commit', '-q', '-am', String(n)]);
      commits.push(sh(runner.root, 'git', ['rev-parse', 'HEAD']).trim());
    }
    for (const sha of commits) {
      const id = await startFor(runner, ['--commit', sha]);
      await ogw(runner.ws, ['instance', 'stop', id]);
    }
    expect(imports(runner)).toBe(3);
    expect(entries(runner)).toHaveLength(2);
    // the entry of the first commit was used before the others: it is gone, and its next start imports again
    const again = await startFor(runner, ['--commit', commits[0] as string]);
    await ogw(runner.ws, ['instance', 'stop', again]);
    expect(imports(runner)).toBe(4);
    const last = await startFor(runner, ['--commit', commits[2] as string]);
    await ogw(runner.ws, ['instance', 'stop', last]);
    expect(imports(runner)).toBe(4);
    // a failed import keeps no entry
    writeFileSync(join(runner.root, 'client', 'main.gd'), 'extends Node # 4\n');
    sh(runner.root, 'git', ['commit', '-q', '-am', '4']);
    const failing = sh(runner.root, 'git', ['rev-parse', 'HEAD']).trim();
    runner.ws.env.FAKE_IMPORT_FAIL = '1';
    expect((await ogw(runner.ws, ['instance', 'start', 'g', '--commit', failing])).code).not.toBe(0);
    delete runner.ws.env.FAKE_IMPORT_FAIL;
    const failed = await startFor(runner, ['--commit', failing]);
    await ogw(runner.ws, ['instance', 'stop', failed]);
    expect(imports(runner)).toBe(6);
    // the game repo checkout imports itself and keeps no entry
    const before = entries(runner).sort();
    mkdirSync(join(runner.root, 'client'), { recursive: true });
    const own = await startFor(runner);
    expect(imports(runner)).toBe(7);
    expect(entries(runner).sort()).toEqual(before);
    await ogw(runner.ws, ['instance', 'stop', own]);
  });
});

/** Waits until `done` holds or `ms` passed: the timeout is what a version that never gets there meets. */
async function until(done: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; !(await done()) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
  return done();
}

describe('ogw instance start: import cache eviction', () => {
  it('removes the entries beyond those kept beside the boot, without the lock of the key: another start of the key copies the new entry meanwhile', async () => {
    runner = gameRunner({ maxConcurrentInstances: 2 });
    const commits: string[] = [];
    for (const n of [1, 2, 3]) {
      writeFileSync(join(runner.root, 'client', 'main.gd'), `extends Node # ${String(n)}\n`);
      sh(runner.root, 'git', ['commit', '-q', '-am', String(n)]);
      commits.push(sh(runner.root, 'git', ['rev-parse', 'HEAD']).trim());
    }
    const [first, second, third] = commits as [string, string, string];
    await ogw(runner.ws, ['instance', 'stop', await startFor(runner, ['--commit', first])]);
    const oldest = entries(runner)[0] as string;
    await ogw(runner.ws, ['instance', 'stop', await startFor(runner, ['--commit', second])]);
    // the start that imports the third commit removes the entry of the first one: that removal waits here
    let letGo = (): void => undefined;
    removal.hold = new Promise((resolve) => {
      letGo = resolve;
    });
    removal.entry = oldest;
    const importing = startFor(runner, ['--commit', third]);
    try {
      expect(await until(() => removal.held, 20_000)).toBe(true);
      // the importing start boots while the removal waits
      expect(await until(async () => (await listRecords((runner as Runner).ws.env)).some((r) => r.status === 'running'), 20_000)).toBe(true);
      // another start of the same files takes the lock of the key and copies the new entry
      const timeout = new Promise<null>((resolve) => {
        setTimeout(() => {
          resolve(null);
        }, 20_000);
      });
      const copying = await Promise.race([startFor(runner, ['--commit', third]), timeout]);
      expect(copying).not.toBeNull();
      expect(imports(runner)).toBe(3);
    } finally {
      letGo();
    }
    await importing;
    expect(entries(runner)).not.toContain(oldest);
    expect(entries(runner)).toHaveLength(2);
  });
});

describe('import cache', () => {
  /** A checkout with these files under its root. */
  function checkout(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'ogw-import-'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  /** A fake import of `root`: `client/.godot/`, a `.uid` file beside `client/main.gd`, and `removes` removed. */
  function importer(root: string, removes: string[] = []): () => Promise<boolean> {
    return () => {
      mkdirSync(join(root, 'client', '.godot'), { recursive: true });
      writeFileSync(join(root, 'client', '.godot', 'uid_cache.bin'), 'cache');
      writeFileSync(join(root, 'client', 'main.gd.uid'), 'uid://a\n');
      for (const path of removes) rmSync(join(root, path));
      return Promise.resolve(true);
    };
  }

  function cacheEntries(commonDir: string): string[] {
    return readdirSync(join(commonDir, IMPORT_CACHE)).filter((n) => /^[0-9a-f]{64}$/.test(n));
  }

  const FILES = { 'client/main.gd': 'extends Node\n', 'client/old.gd.import': '[remap]\n' };

  it('fails a copy that fails, and removes the entry and the copied client/.godot/', async () => {
    const cache = { commonDir: mkdtempSync(join(tmpdir(), 'ogw-common-')), keep: 4 };
    const made = checkout(FILES);
    expect((await importThroughCache(cache, made, 'godot', importer(made))).ran).toBe(true);
    const [key] = cacheEntries(cache.commonDir) as [string];
    // the entry lacks a file its manifest names: the copy of the products fails after client/.godot/ was copied
    rmSync(join(cache.commonDir, IMPORT_CACHE, key, 'files', 'client', 'main.gd.uid'));
    const root = checkout(FILES);
    const fresh = vi.fn(importer(root));
    await expect(importThroughCache(cache, root, 'godot', fresh)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fresh).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'client', '.godot'))).toBe(false);
    expect(cacheEntries(cache.commonDir)).toEqual([]);
  });

  it('gives the checkout a copy without the files the import removed', async () => {
    const cache = { commonDir: mkdtempSync(join(tmpdir(), 'ogw-common-')), keep: 4 };
    const made = checkout(FILES);
    expect((await importThroughCache(cache, made, 'godot', importer(made, ['client/old.gd.import']))).ran).toBe(true);
    const root = checkout(FILES);
    expect((await importThroughCache(cache, root, 'godot', importer(root))).ran).toBe(false);
    expect(existsSync(join(root, 'client', 'old.gd.import'))).toBe(false);
    expect(readFileSync(join(root, 'client', 'main.gd.uid'), 'utf8')).toBe('uid://a\n');
    expect(existsSync(join(root, 'client', '.godot', 'uid_cache.bin'))).toBe(true);
  });

  it('takes into the key the content of a file and of a folder that a link points to outside client/ and resource/', async () => {
    const root = checkout({ 'client/main.gd': 'extends Node\n' });
    const outside = checkout({ 'shared.txt': 'a', 'art/b.txt': 'b' });
    symlinkSync(join(outside, 'shared.txt'), join(root, 'client', 'shared.txt'));
    symlinkSync(join(outside, 'art'), join(root, 'client', 'art'));
    const keys = [await importKey(root, 'godot')];
    writeFileSync(join(outside, 'shared.txt'), 'a2');
    keys.push(await importKey(root, 'godot'));
    writeFileSync(join(outside, 'art', 'b.txt'), 'b2');
    keys.push(await importKey(root, 'godot'));
    expect(new Set(keys).size).toBe(3);
  });
});
