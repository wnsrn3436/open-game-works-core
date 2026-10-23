import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { withReader, withWriter, withWriterLock } from '../../src/lib/rwlock.ts';

describe('rwlock', () => {
  it('lets readers run together, and a writer wait for them while it keeps new readers of other processes out', async () => {
    const lock = { base: join(mkdtempSync(join(tmpdir(), 'ogw-rwlock-')), 'lock'), waitMs: 60_000 };
    const order: string[] = [];
    let endFirst: () => void = () => undefined;
    const first = withReader(lock, () => new Promise<void>((resolve) => {
      order.push('reader 1');
      endFirst = resolve;
    }));
    await sleep(100);
    await withReader(lock, () => {
      order.push('reader 2');
      return Promise.resolve();
    });
    const writer = withWriter(lock, () => {
      order.push('writer');
      return Promise.resolve();
    });
    await sleep(300);
    expect(order).toEqual(['reader 1', 'reader 2']);
    endFirst();
    await Promise.all([first, writer]);
    expect(order).toEqual(['reader 1', 'reader 2', 'writer']);
    // with no reader of this process left, a new reader takes the writer lock, which a waiting writer holds
    const held = withWriter(lock, () => sleep(300).then(() => order.push('writer 2')));
    await sleep(100);
    await withReader(lock, () => {
      order.push('reader 3');
      return Promise.resolve();
    });
    await held;
    expect(order.slice(3)).toEqual(['writer 2', 'reader 3']);
  });

  it('lets a writer that waits for the writer lock go before readers and writer lock holders that start after it', async () => {
    const lock = { base: join(mkdtempSync(join(tmpdir(), 'ogw-rwlock-')), 'lock'), waitMs: 60_000 };
    const order: string[] = [];
    // a run that holds the writer lock (a generated file commit) while the writer starts to wait
    const commit = withWriterLock(lock, () => sleep(400).then(() => order.push('commit')));
    await sleep(100);
    const writer = withWriter(lock, () => sleep(200).then(() => order.push('writer')));
    await sleep(100);
    const nextCommit = withWriterLock(lock, () => Promise.resolve(order.push('next commit')));
    const reader = withReader(lock, () => Promise.resolve(order.push('reader')));
    await Promise.all([commit, writer, nextCommit, reader]);
    expect(order.slice(0, 2)).toEqual(['commit', 'writer']);
    expect(order.slice(2).sort()).toEqual(['next commit', 'reader']);
    expect(readdirSync(`${lock.base}-writers`)).toEqual([]);
  });

  it('lets a writer that starts to wait while a reader waits for the writer lock go first', async () => {
    const lock = { base: join(mkdtempSync(join(tmpdir(), 'ogw-rwlock-')), 'lock'), waitMs: 60_000 };
    const order: string[] = [];
    const commit = withWriterLock(lock, () => sleep(600).then(() => order.push('commit')));
    await sleep(50);
    // no writer waits yet: the reader passes the writer wait and polls the writer lock
    const reader = withReader(lock, () => Promise.resolve(order.push('reader')));
    await sleep(100);
    const writer = withWriter(lock, () => sleep(200).then(() => order.push('writer')));
    await Promise.all([commit, reader, writer]);
    expect(order).toEqual(['commit', 'writer', 'reader']);
  });

  it('runs a reader nested in a reader of the same lock at once, even while a writer waits', async () => {
    const lock = { base: join(mkdtempSync(join(tmpdir(), 'ogw-rwlock-')), 'lock'), waitMs: 60_000 };
    let writer: Promise<void> = Promise.resolve();
    const inner = await withReader(lock, async () => {
      writer = withWriter(lock, () => Promise.resolve());
      await sleep(200);
      return withReader(lock, () => Promise.resolve('inner'));
    });
    expect(inner).toBe('inner');
    await writer;
  });

  it('keeps the reader entry until the last reader of this process ends, even when the first one ends first', async () => {
    const lock = { base: join(mkdtempSync(join(tmpdir(), 'ogw-rwlock-')), 'lock'), waitMs: 60_000 };
    let endSibling: () => void = () => undefined;
    let sibling: Promise<void> = Promise.resolve();
    // the sibling starts after the first reader took the entry, and outlives it
    await withReader(lock, () => {
      sibling = withReader(lock, () => new Promise<void>((resolve) => {
        endSibling = resolve;
      }));
      return Promise.resolve();
    });
    expect(readdirSync(`${lock.base}-readers`)).toHaveLength(1);
    let wrote = false;
    const writer = withWriter(lock, () => {
      wrote = true;
      return Promise.resolve();
    });
    await sleep(800);
    expect(wrote).toBe(false);
    endSibling();
    await sibling;
    await writer;
    expect(wrote).toBe(true);
    expect(readdirSync(`${lock.base}-readers`)).toEqual([]);
  });
});
