import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withToolReaders } from '../../../../src/commands/core/lib/tools.ts';
import { checkoutLock } from '../../../../src/lib/git.ts';
import { withWriter } from '../../../../src/lib/rwlock.ts';
import { makeWorkspace } from '../../../helpers/workspace.ts';

describe('withToolReaders', () => {
  it('holds a reader of each tool folder, so a tool build waits until the readers end', async () => {
    const ws = makeWorkspace();
    for (const tool of ['contract-tool', 'data-tool']) {
      mkdirSync(join(ws.coreImpl, 'tools', tool), { recursive: true });
      writeFileSync(join(ws.coreImpl, 'tools', tool, 'package.json'), '{}\n');
    }
    const order: string[] = [];
    let release: () => void = () => undefined;
    const reading = withToolReaders(ws.env, ws.coreImpl, async () => {
      order.push('read start');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push('read end');
    });
    await new Promise((r) => setTimeout(r, 100));
    const lock = { base: await checkoutLock(ws.coreImpl, 'ogw-data-tool-build.lock', { env: ws.env }), waitMs: 10_000 };
    const building = withWriter(lock, () => {
      order.push('build');
      return Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(order).toEqual(['read start']);
    release();
    await Promise.all([reading, building]);
    expect(order).toEqual(['read start', 'read end', 'build']);
  });
});
