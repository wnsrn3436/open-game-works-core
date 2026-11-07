import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { withLock } from '../../../lib/lock.ts';
import { addEntry, liveEntries, withReader, writerHoldsOrWaits, type RwLock } from '../../../lib/rwlock.ts';
import { takeWaits, taking } from '../../../lib/spans.ts';
import { dataDir } from '../../env/lib/host.ts';
import { readMark } from '../../regress/lib/mark.ts';

/**
 * The reader/writer lock of the performance lease (ogw.md `### performance lease`), beside the lock that keeps one
 * `generation run` at a time on this host: `generation run` reads it, the performance measurement of `ogw check` writes it.
 */
export async function performanceLeaseBase(ctx: Context): Promise<string> {
  return join(await dataDir(ctx), 'generation', 'performance-lease');
}

/**
 * Runs the calls of a `generation run` holding the performance lease shared. While a performance measurement holds or
 * waits for the lease, it waits, at most the time limit of its background job.
 */
export async function withGenerationLease<T>(ctx: Context, fn: () => Promise<T>): Promise<T> {
  return withReader({ base: await performanceLeaseBase(ctx), waitMs: LIMITS.jobMs }, fn);
}

/** How often a heavy step that waits for the lease and a measurement that waits for the heavy steps look again. */
const STEP_POLL_MS = 500;

/** The folder of the entries of the heavy steps that hold the lease: one per step, with the owner of its process. */
function stepsDir(lease: RwLock): string {
  return `${lease.base}-steps`;
}

/** The lock under which a heavy step checks the lease and leaves its entry, and a measurement counts the entries. */
function stepsGate(lease: RwLock): string {
  return `${lease.base}-steps.lock`;
}

/** Set inside a heavy step that holds the lease: a heavy step inside it does not wait again. */
const holding = new AsyncLocalStorage<true>();

/**
 * Runs `fn`, a heavy step of a check (ogw.md `### performance lease`: the client import, a GUT run, a server test run,
 * the type check of the static check, a data tool binary build, the generated files of the fix test proof), holding the
 * performance lease shared when the checkout is of a game with the regression mark (`game.commonDir`). It starts only
 * while no performance measurement holds or waits for the lease, so that a waiting measurement goes first; that wait
 * lasts at most the time limit of a job. A heavy step inside another runs at once: the outer one holds the lease.
 * Call it before taking the locks of the step, so that no lock is held while it waits.
 */
export async function withHeavyStep<T>(ctx: Context, game: { commonDir: string }, fn: () => Promise<T>): Promise<T> {
  if (holding.getStore() === true || (await readMark(game.commonDir)) === null) return fn();
  const lease: RwLock = { base: await performanceLeaseBase(ctx), waitMs: 0 };
  const deadline = Date.now() + LIMITS.jobMs;
  // a take that waits for a measurement is a wait on the lease (ogw.md `## time`)
  const release = await taking(lease.base, async () => {
    for (;;) {
      // checked under the gate, under which a measurement counts the entries (`heavyStepsEnd`)
      const taken = await withLock(stepsGate(lease), async () => ((await writerHoldsOrWaits(lease)) ? null : addEntry(stepsDir(lease))));
      if (taken !== null) return taken;
      takeWaits();
      if (Date.now() >= deadline) throw new OgwError(`no heavy step start within ${String(LIMITS.jobMs)} ms: performance measurements held the performance lease`);
      await sleep(STEP_POLL_MS);
    }
  });
  try {
    return await holding.run(true, fn);
  } finally {
    await release();
  }
}

/**
 * Waits until no heavy step holds the lease `lease` (ogw.md `### performance lease`); false when `deadline` came first.
 * It counts the entries under the gate, under which a heavy step checks the lease before it leaves its entry
 * (`withHeavyStep`): a measurement that holds the writer lock of the lease sees every heavy step that started before.
 * An entry whose process is gone is removed. The wait for the heavy steps is a wait on the lease (ogw.md `## time`).
 */
export async function heavyStepsEnd(lease: RwLock, deadline: number): Promise<boolean> {
  return taking(lease.base, async () => {
    for (;;) {
      const held = await withLock(stepsGate(lease), async () => (await liveEntries(stepsDir(lease))) > 0);
      if (!held) return true;
      takeWaits();
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(STEP_POLL_MS, Math.max(0, deadline - Date.now())));
    }
  });
}
