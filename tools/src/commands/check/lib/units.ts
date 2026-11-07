import type { Slots } from './instances.ts';

/** Units `0..count-1`, claimed one at a time in order; once `stopAfter(i)`, no unit after `i` is claimed. */
export class UnitQueue {
  private next = 0;
  private end: number;

  constructor(count: number) {
    this.end = count;
  }

  claim(): number | null {
    return this.next < this.end ? this.next++ : null;
  }

  stopAfter(index: number): void {
    this.end = Math.min(this.end, index + 1);
  }

  /** The units that are not claimed and can still be claimed. */
  get left(): number {
    return Math.max(0, this.end - this.next);
  }
}

/**
 * A helper of {@link shareUnits}: it gets ready (e.g. starts an instance, which `signal` stops once the helper is no
 * longer wanted), then calls `next` for each unit it runs until `next` gives null.
 */
export type Helper = (next: () => number | null, signal: AbortSignal) => Promise<void>;

export interface SharedUnits {
  /** The next unit for the runner the caller owns, or null when none is left. */
  claim(): number | null;
  /** No unit after `index` is claimed (`UnitQueue.stopAfter`), and a helper still getting ready is stopped. */
  stopAfter(index: number): void;
  /** Ends once every helper has ended. */
  helpers(): Promise<void>;
}

/**
 * The units of `queue`, run by the runner the caller owns (its `claim`) and by helpers on spare slots of `slots`
 * (`Slots.spare`). From its first claim on, whenever a unit is claimed or a slot becomes free, each slot that is free
 * starts one more helper while more units are left than helpers are getting ready. A helper claims units until none is
 * left or a holder of `slots` waits; a helper still getting ready then is stopped. The failure of a helper that was not
 * stopped is given to `failed`, and no helper starts after it; the units it did not claim stay for the others.
 */
export function shareUnits(slots: Slots, queue: UnitQueue, helper: Helper, failed: (error: unknown) => void): SharedUnits {
  const running: Promise<void>[] = [];
  const ready = new Set<AbortController>();
  let unwatch: (() => void) | null = null;
  // a helper that failed (e.g. its instance did not start): another would fail the same way, so none starts again
  let broken = false;
  const settle = (): void => {
    if (queue.left > 0) return;
    for (const controller of ready) controller.abort();
    unwatch?.();
    unwatch = null;
  };
  const spawn = (): void => {
    while (!broken && queue.left > ready.size) {
      const controller = new AbortController();
      let wanted = false;
      const release = slots.spare(() => {
        wanted = true;
        if (ready.has(controller)) controller.abort();
      });
      if (release === null) return;
      ready.add(controller);
      const next = (): number | null => {
        ready.delete(controller);
        if (wanted) return null;
        const index = queue.claim();
        if (index !== null) spawn();
        settle();
        return index;
      };
      running.push(
        (async (): Promise<void> => {
          try {
            await helper(next, controller.signal);
          } catch (error) {
            if (!controller.signal.aborted) {
              broken = true;
              failed(error);
            }
          } finally {
            ready.delete(controller);
            release();
          }
        })(),
      );
    }
  };
  return {
    claim(): number | null {
      const index = queue.claim();
      if (index !== null) {
        unwatch ??= slots.watch(spawn);
        spawn();
      }
      settle();
      return index;
    },
    stopAfter(index: number): void {
      queue.stopAfter(index);
      settle();
    },
    async helpers(): Promise<void> {
      // a helper that ends can start another: wait until none is left
      for (let i = 0; i < running.length; i++) await running[i];
      unwatch?.();
      unwatch = null;
    },
  };
}
