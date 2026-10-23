import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { isGeneratedPath, testAtHead, withCoreMain } from '../../../../src/commands/core/lib/main-checkout.ts';
import { makeWorkspace, sh } from '../../../helpers/workspace.ts';

describe('main checkout lock', () => {
  it('lets a merge wait for the module tests of a core test run, and a core test run started meanwhile wait for the merge', async () => {
    const ws = makeWorkspace();
    const order: string[] = [];
    const first = await testAtHead(ws.coreImpl, ws.coreImpl, ws.env, () => Promise.resolve());
    expect(first.head).toBe(sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim());
    // a second run tests at the same time as the first
    const second = await testAtHead(ws.coreImpl, ws.coreImpl, ws.env, () => Promise.resolve());
    const merge = withCoreMain(ws.coreImpl, ws.env, () => {
      order.push('merge');
      return Promise.resolve();
    }, { readers: true });
    await sleep(300);
    const third = testAtHead(ws.coreImpl, ws.coreImpl, ws.env, () => {
      order.push('third');
      return Promise.resolve();
    });
    await sleep(300);
    expect(order).toEqual([]);
    await first.release();
    await sleep(800);
    expect(order).toEqual([]);
    await second.release();
    await merge;
    await (await third).release();
    expect(order).toEqual(['merge', 'third']);
  });

  it('reads the checkout clean after the generated commit, while the writer is held', async () => {
    const ws = makeWorkspace();
    // the preflight writes a generated file: it is committed before the clean check
    const generated = await testAtHead(ws.coreImpl, ws.coreImpl, ws.env, () => {
      mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
      writeFileSync(join(ws.coreImpl, 'core-spec', 'X.json'), '{}\n');
      return Promise.resolve();
    });
    expect(generated.clean).toBe(true);
    expect(generated.head).toBe(sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim());
    await generated.release();
    // a generated file changed before the run is committed by it: the run is of a clean new commit
    const before = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(ws.coreImpl, 'core-spec', 'X.json'), '{"changed": true}\n');
    const regenerated = await testAtHead(ws.coreImpl, ws.coreImpl, ws.env, () => Promise.resolve());
    expect(regenerated.clean).toBe(true);
    expect(regenerated.head).not.toBe(before);
    await regenerated.release();
    // a change that is not a generated file stays: the run is not of a clean commit
    writeFileSync(join(ws.coreImpl, 'note.txt'), 'x');
    const dirty = await testAtHead(ws.coreImpl, ws.coreImpl, ws.env, () => Promise.resolve());
    expect(dirty.clean).toBe(false);
    await dirty.release();
  });

  it('takes over a reader entry whose run is gone', async () => {
    const ws = makeWorkspace();
    const readers = join(sh(ws.coreImpl, 'git', ['rev-parse', '--absolute-git-dir']).trim(), 'ogw-core-main.lock-readers', 'gone');
    mkdirSync(readers, { recursive: true });
    writeFileSync(join(readers, 'pid'), '999999999\n');
    expect(await withCoreMain(ws.coreImpl, ws.env, () => Promise.resolve('merged'), { readers: true })).toBe('merged');
  });

  it('names the generated files: core-spec/ and the committed generation targets of the core test data', () => {
    for (const path of ['core-spec/a.json', 'server/generated/data/x.ts', 'server/dev/generated/data/y.ts', 'client/godot/generated/data/z.gd', 'client/godot/dev/generated/data/w.gd']) {
      expect(isGeneratedPath(path)).toBe(true);
    }
    for (const path of ['server/core/a.ts', 'server/build/data/x.bin', 'client/godot/core/a.gd', 'core-spec.json', 'README']) expect(isGeneratedPath(path)).toBe(false);
  });
});
