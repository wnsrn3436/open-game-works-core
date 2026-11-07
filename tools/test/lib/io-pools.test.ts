import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareFolders } from '../../src/commands/check/static/core-diff.ts';
import { godotTypeCheck } from '../../src/commands/code/gdscript-checks.ts';
import { applyPlan, emptyPlan } from '../../src/commands/generate/lib/apply.ts';
import { tickChangedVersions } from '../../src/commands/generate/lib/sim.ts';
import { gitRaw } from '../../src/lib/git.ts';
import { scanFiles } from '../../src/lib/secret-scan.ts';
import { bothModes } from '../helpers/godot.ts';
import { commitAll, gitInit, gitOnlyHarness, sh } from '../helpers/workspace.ts';

vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock('../../src/lib/git.ts', async (orig) => {
  const actual = await orig<typeof import('../../src/lib/git.ts')>();
  return { ...actual, gitRaw: vi.fn(actual.gitRaw) };
});

/** The most calls of a wrapped function that were in flight at once, each held for 3 ms. */
const flight = { now: 0, most: 0 };

async function held<T>(work: () => Promise<T>): Promise<T> {
  flight.now++;
  flight.most = Math.max(flight.most, flight.now);
  try {
    await new Promise((resolve) => setTimeout(resolve, 3));
    return await work();
  } finally {
    flight.now--;
  }
}

beforeEach(async () => {
  flight.now = 0;
  flight.most = 0;
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(readFile).mockImplementation((...args: Parameters<typeof fs.readFile>) => held(() => fs.readFile(...args)));
});

afterEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(readFile).mockImplementation(fs.readFile);
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ogw-io-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const many = (prefix: string, n: number, text = 'x'): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${String(i).padStart(2, '0')}.txt`, `${text}${String(i)}`]));

describe('reads several at a time, results in order', () => {
  it('core diff compares files several at a time and keeps the file order of its findings', async () => {
    const game = tree({ ...many('a/', 20), 'a/05.txt': 'changed', 'only-game.txt': 'g' });
    const release = tree({ ...many('a/', 20), 'only-release.txt': 'r' });
    const found = await compareFolders(game, release, 'client/core/', '1.0.0');
    expect(found.map((f) => `${f.where} ${f.message}`)).toEqual([
      'client/core/a/05.txt:1 core diff: differs from core 1.0.0',
      'client/core/only-game.txt:1 core diff: not in core 1.0.0',
      'client/core:1 core diff: client/core/only-release.txt missing; core 1.0.0 has it',
    ]);
    expect(flight.most).toBeGreaterThan(2);
  });

  it('the secret scan reads files several at a time and keeps the order of the files in its failures', async () => {
    const root = tree({ ...many('f/', 20, 'clean'), 'f/03.txt': 'the KEY here', 'f/17.txt': 'KEY' });
    const files = Object.keys({ ...many('f/', 20) }).sort();
    const hits = await scanFiles(root, [...files, 'gone.txt'], [{ label: 'api key', value: Buffer.from('KEY') }], { lines: true });
    expect(hits).toEqual(['f/03.txt:1: api key', 'f/17.txt:1: api key']);
    expect(flight.most).toBeGreaterThan(2);
  });

  it('the Godot type check reads the files of its cache key ahead of the hash, which takes them in order', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'ogw-io-godot-'));
    const godot = join(bin, 'godot');
    writeFileSync(godot, `#!/bin/sh\n${bothModes('exit 0')}`);
    chmodSync(godot, 0o755);
    const root = tree({ ...many('client/assets/', 20), 'client/features/a/a.gd': 'extends Node\n' });
    const project = { root, folder: 'client', repoPathOf: (res: string) => `client/${res.slice('res://'.length)}` };
    const env = { ...process.env, OGW_HARNESS_ROOT: gitOnlyHarness() };
    expect(await godotTypeCheck(godot, project, ['client/features/a/a.gd'], env, { imported: true })).toEqual([]);
    expect(flight.most).toBeGreaterThan(2);
    // the same inputs give the same key: the passed check is taken from the cache, and godot does not run again
    chmodSync(godot, 0o644);
    expect(await godotTypeCheck(godot, project, ['client/features/a/a.gd'], env, { imported: true })).toEqual([]);
  });

  it('ogw generate writes the files of a part of its plan several at a time and lists them in order', async () => {
    const root = tree({});
    const source = tree(many('', 20));
    const plan = emptyPlan();
    plan.overlays.push({ source, target: 'client/core' });
    for (const [path, text] of Object.entries(many('server/generated/', 10))) plan.files.set(path, text);
    const applied = await applyPlan(root, plan);
    expect(applied.written).toEqual([...Object.keys(many('client/core/', 20)), ...Object.keys(many('server/generated/', 10))]);
    expect(flight.most).toBeGreaterThan(2);
  });

  it('TickChangedVersions reads the tags several at a time', async () => {
    const actual = await vi.importActual<typeof import('../../src/lib/git.ts')>('../../src/lib/git.ts');
    vi.mocked(gitRaw).mockImplementation((...args) => held(() => actual.gitRaw(...args)));
    try {
      const root = tree({ 'client/features/a/sim/step.gd': 'extends RefCounted\n' });
      gitInit(root);
      commitAll(root, 'one');
      for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) sh(root, 'git', ['tag', `prod-${v}`]);
      writeFileSync(join(root, 'client/features/a/sim/step.gd'), 'extends RefCounted\n# changed\n');
      expect(await tickChangedVersions(root)).toBe('export const TickChangedVersions: readonly string[] = ["1.0.0", "1.1.0", "1.2.0", "1.3.0"];\n');
      expect(flight.most).toBeGreaterThan(2);
    } finally {
      vi.mocked(gitRaw).mockImplementation(actual.gitRaw);
    }
  });
});
