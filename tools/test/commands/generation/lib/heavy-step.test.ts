import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { heavyStepsEnd, performanceLeaseBase, withHeavyStep } from '../../../../src/commands/generation/lib/lease.ts';
import { writeMark } from '../../../../src/commands/regress/lib/mark.ts';
import { hostBootId, pidNamespace } from '../../../../src/lib/proc.ts';
import { inJob } from '../../../../src/lib/spans.ts';
import { withWriter, withWriterWithin, writerHoldsOrWaits, type RwLock } from '../../../../src/lib/rwlock.ts';
import { makeGame, makeWorkspace } from '../../../helpers/workspace.ts';
import { ctxOf } from '../../regress/helpers.ts';

/** A workspace with the game `marked`, which has the regression mark, and the game `plain`, which has not. */
async function games(): Promise<{ ctx: ReturnType<typeof ctxOf>; marked: { commonDir: string }; plain: { commonDir: string }; lease: RwLock }> {
  const ws = makeWorkspace();
  makeGame(ws, 'marked', { 'settings.json': {} });
  makeGame(ws, 'plain', { 'settings.json': {} });
  const ctx = ctxOf(ws);
  const marked = await ctx.game('marked');
  await writeMark(marked.commonDir, { kind: 'state', state: 's' });
  return { ctx, marked, plain: await ctx.game('plain'), lease: { base: await performanceLeaseBase(ctx), waitMs: 60_000 } };
}

/** A measurement that holds the lease exclusively once the heavy steps have ended, for `ms`. */
function measurement(lease: RwLock, order: string[], ms: number): Promise<unknown> {
  return withWriterWithin(lease, async () => {
    order.push('measurement');
    await sleep(ms);
    order.push('measurement ends');
  }, (deadline) => heavyStepsEnd(lease, deadline));
}

/** A heavy step that holds the lease until `end` is called. */
function held(ctx: ReturnType<typeof ctxOf>, game: { commonDir: string }, order: string[], name: string): { done: Promise<void>; end: () => void } {
  let end = (): void => undefined;
  const done = withHeavyStep(ctx, game, () => new Promise<void>((resolve) => {
    order.push(name);
    end = resolve;
  }));
  return {
    done,
    end: () => {
      end();
    },
  };
}

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await condition())) await sleep(10);
}

describe('a heavy step of a check', () => {
  it('of a game with the regression mark waits while a measurement holds the lease; one of another game does not', async () => {
    const { ctx, marked, plain, lease } = await games();
    const order: string[] = [];
    const measuring = withWriter(lease, async () => {
      order.push('measurement');
      await sleep(400);
      order.push('measurement ends');
    });
    await until(() => order.includes('measurement'));
    const spans = join(mkdtempSync(join(tmpdir(), 'ogw-spans-')), 'j.spans.jsonl');
    await inJob('j', spans, async () => {
      await withHeavyStep(ctx, plain, () => Promise.resolve(order.push('plain step')));
      await withHeavyStep(ctx, marked, () => Promise.resolve(order.push('marked step')));
    });
    await measuring;
    expect(order).toEqual(['measurement', 'plain step', 'measurement ends', 'marked step']);
    // the wait of the marked step is a wait on the lease (ogw.md `## time`)
    const waits = readFileSync(spans, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { wait?: string; end: number | null });
    expect(waits.filter((w) => w.end !== null).map((w) => w.wait)).toEqual([lease.base]);
  });

  it('is waited for by a measurement, which goes before a heavy step that comes while it waits', async () => {
    const { ctx, marked, lease } = await games();
    const order: string[] = [];
    const first = held(ctx, marked, order, 'first step');
    await until(() => order.includes('first step'));
    const measuring = measurement(lease, order, 200);
    await until(() => writerHoldsOrWaits(lease));
    const second = held(ctx, marked, order, 'second step');
    await sleep(600);
    // the measurement waits for the step it found, and the step that came after it waits for the measurement
    expect(order).toEqual(['first step']);
    first.end();
    await first.done;
    await measuring;
    await until(() => order.includes('second step'));
    second.end();
    await second.done;
    expect(order).toEqual(['first step', 'measurement', 'measurement ends', 'second step']);
  });

  it('inside another runs at once while a measurement waits, as the outer one holds the lease', async () => {
    const { ctx, marked, lease: waitLong } = await games();
    // a measurement that waited past this would leave the inner step to run after its wait
    const lease = { ...waitLong, waitMs: 3000 };
    const order: string[] = [];
    let measuring: Promise<unknown> = Promise.resolve();
    await withHeavyStep(ctx, marked, async () => {
      order.push('outer step');
      measuring = measurement(lease, order, 10);
      await until(() => writerHoldsOrWaits(lease));
      await withHeavyStep(ctx, marked, () => Promise.resolve(order.push('inner step')));
    });
    await measuring;
    expect(order).toEqual(['outer step', 'inner step', 'measurement', 'measurement ends']);
  });

  it('left by a process that is gone holds nothing', async () => {
    const { lease } = await games();
    const gone = Number(spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim());
    const entry = join(`${lease.base}-steps`, 'gone');
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'pid'), `${String(gone)}\n${pidNamespace() ?? ''}\n${hostBootId() ?? ''}\n${String(Math.random())}\n`);
    expect(await heavyStepsEnd(lease, Date.now() + 2000)).toBe(true);
  });
});
