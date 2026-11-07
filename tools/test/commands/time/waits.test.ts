// The waits and step spans of the shared helpers of the commands (ogw.md `## time`): the regress pool, its check gate and
// its merges, the instance slots of a check, the measure gate of a build, and the step spans whose work goes on across
// tasks (`openSpan`, `openWait`), and an `inJob` that goes on in the span of another process.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { atGate, measureGate, MEASURE_GATE, NO_GATE } from '../../../src/commands/build/lib/client-check.ts';
import { CHECK_SLOTS, Slots } from '../../../src/commands/check/lib/instances.ts';
import { REGRESS_POOL, regressPool } from '../../../src/commands/regress/lib/pool.ts';
import { inJob, openSpan, openWait, span, spanContext, type SpanLine } from '../../../src/lib/spans.ts';

function file(): string {
  return join(realpathSync(mkdtempSync(join(tmpdir(), 'ogw-waits-'))), 'j.spans.jsonl');
}

function lines(path: string): SpanLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as SpanLine);
}

/** The ended waits of a spans file as `[on, ms]`. */
function waits(path: string): [string, number][] {
  return lines(path).flatMap((l): [string, number][] => ('wait' in l && l.end !== null ? [[l.wait, l.end - l.start]] : []));
}

describe('waits of the shared helpers of the commands', () => {
  it('records a wait for a place of the regress pool, and none for work that finds one', async () => {
    const path = file();
    const pool = regressPool(1);
    await inJob('p', path, async () => {
      const first = pool.work(() => sleep(300));
      await pool.work(() => Promise.resolve());
      await first;
    });
    expect(waits(path).map(([on]) => on)).toEqual([REGRESS_POOL]);
    expect(waits(path)[0]?.[1]).toBeGreaterThanOrEqual(250);
  });

  it('records a wait at the check gate for a check that does not start at once, and on the merges of one game', async () => {
    const path = file();
    const pool = regressPool(4, true);
    await inJob('p', path, async () => {
      const loud = pool.check(true, () => sleep(300));
      await pool.check(false, () => Promise.resolve());
      await loud;
      const merging = pool.merge('g', () => sleep(300));
      await pool.merge('g', () => Promise.resolve());
      await pool.merge('h', () => Promise.resolve());
      await merging;
    });
    expect(waits(path).map(([on]) => on)).toEqual(['regress check gate', 'regress merges g']);
  });

  it('records a wait for a free instance slot of a check, and none for an acquire that takes one', async () => {
    const path = file();
    const slots = new Slots(1);
    await inJob('c', path, async () => {
      await slots.acquire();
      setTimeout(() => {
        slots.release();
      }, 300);
      await slots.acquire();
      slots.release();
    });
    expect(waits(path).map(([on]) => on)).toEqual([CHECK_SLOTS]);
    expect(waits(path)[0]?.[1]).toBeGreaterThanOrEqual(250);
  });

  it('records a wait at the measure gate of a build check until the gate opens, and none at an open gate', async () => {
    const path = file();
    const gate = measureGate();
    await inJob('b', path, async () => {
      await atGate(NO_GATE);
      setTimeout(() => {
        gate.open(null);
      }, 300);
      await atGate(gate.gate);
      await atGate(gate.gate);
    });
    expect(waits(path).map(([on]) => on)).toEqual([MEASURE_GATE]);
    const closed = measureGate();
    closed.open('not measured');
    await expect(inJob('b', file(), () => atGate(closed.gate))).rejects.toThrow('not measured');
  });
});

describe('step spans across tasks', () => {
  it('runs work of an open span in it, ends it once, and records nothing outside a job', async () => {
    const path = file();
    await inJob('o', path, async () => {
      const open = openSpan('play');
      const id = await open.run(() => Promise.resolve(spanContext()?.span ?? null));
      await open.run(() => span('inner', () => Promise.resolve()));
      open.end(true);
      open.end();
      expect(id).not.toBeNull();
      const wait = openWait('evaluate room');
      await sleep(50);
      wait.end();
      wait.end();
    });
    const all = lines(path);
    const play = all.filter((l) => 'name' in l && l.name === 'play');
    expect(play).toHaveLength(2);
    expect(play[1]).toMatchObject({ failed: true });
    expect(all.find((l) => 'name' in l && l.name === 'inner')).toMatchObject({ parent: play[0]?.id });
    expect(waits(path).map(([on]) => on)).toEqual(['evaluate room']);
    const outside = openSpan('x');
    expect(await outside.run(() => Promise.resolve(5))).toBe(5);
    outside.end();
    openWait('y').end();
  });

  it('writes `job start` first, writes nothing after the command ended, and leaves a failure when asked', async () => {
    const path = file();
    let later: Promise<void> = Promise.resolve();
    await inJob('s', path, () => {
      // work the command leaves running after it ended
      later = sleep(100).then(() => span('late', () => Promise.resolve()));
      return Promise.resolve();
    }, { startedAt: Date.now() - 500 });
    await later;
    expect(lines(path).map((l) => ('name' in l ? l.name : l.wait))).toEqual(['job start', 'job start']);
    expect((lines(path)[1] as { start: number; end: number }).end - (lines(path)[1] as { start: number }).start).toBeGreaterThanOrEqual(500);
    // a folder where the file goes: no line can be written; the context then names the job span, and `leave` does not throw
    const folder = join(realpathSync(mkdtempSync(join(tmpdir(), 'ogw-waits-'))), 'f.spans.jsonl');
    mkdirSync(folder);
    const seen = await inJob('s', folder, () => span('a', () => Promise.resolve(spanContext())), { writeFailure: 'leave' });
    expect(seen).toEqual({ job: 's', span: null });
    await expect(inJob('s', folder, () => span('a', () => Promise.resolve(1)))).rejects.toThrow(/cannot write the spans file/);
  });

  it('goes on in the span of another process of the job given as the parent', async () => {
    const path = file();
    await inJob('s', path, () => span('step', () => Promise.resolve()), { parent: 'other.1' });
    expect(lines(path)[0]).toMatchObject({ name: 'step', parent: 'other.1' });
  });
});
