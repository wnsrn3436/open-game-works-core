/**
 * The values of `work`, as `Promise.all` gives them, once every piece of work has ended, also after one of them failed,
 * so that no work of a command runs on after the command failed; then the first failure is thrown.
 */
export async function every<T extends readonly unknown[] | []>(work: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const results: PromiseSettledResult<unknown>[] = await Promise.allSettled(work as readonly unknown[]);
  for (const r of results) if (r.status === 'rejected') throw r.reason as Error;
  return results.map((r) => (r as PromiseFulfilledResult<unknown>).value) as { -readonly [P in keyof T]: Awaited<T[P]> };
}

/** Runs `work` over `items`, at most `limit` at a time, keeping the order of the results. */
export async function pooled<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    // after a failure no more work starts; the work that runs ends
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await work(items[index] as T, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await every(lanes);
  return results;
}

/** Runs pieces of work at most `limit` at a time, in the order they came. */
export interface Limiter {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export function limiter(limit: number): Limiter {
  const waiting: (() => void)[] = [];
  let running = 0;
  return {
    async run(work) {
      if (running >= Math.max(1, limit)) await new Promise<void>((start) => waiting.push(start));
      else running += 1;
      try {
        return await work();
      } finally {
        // the slot goes to the first that waits, or is free
        const next = waiting.shift();
        if (next === undefined) running -= 1;
        else next();
      }
    },
  };
}

/**
 * The checks of one `ogw regress run` whose side tools do not hold the performance lease for their instances (ogw.md
 * `### regress run`): a check with performance runs while no other check runs. It starts once the checks running have
 * ended, and a check that comes while it waits starts after it, so that checks without performance that start beside
 * each other do not keep it out.
 */
export interface CheckGate {
  run<T>(performance: boolean, check: () => Promise<T>): Promise<T>;
}

export function checkGate(): CheckGate {
  const waiting: { performance: boolean; start: () => void }[] = [];
  let running = 0;
  let alone = false;
  const startNext = (): void => {
    for (let next = waiting[0]; next !== undefined && !alone && (!next.performance || running === 0); next = waiting[0]) {
      waiting.shift();
      running += 1;
      alone = next.performance;
      next.start();
    }
  };
  return {
    async run(performance, check) {
      await new Promise<void>((start) => {
        waiting.push({ performance, start });
        startNext();
      });
      try {
        return await check();
      } finally {
        running -= 1;
        // a check with performance ran alone: it is the one that ends
        alone = false;
        startNext();
      }
    },
  };
}

/**
 * The work of one `ogw regress` command (ogw.md `## regress`): its side commands, fixer agents, merges, core upgrades and
 * patch applications run together, at most `regress.parallel` at a time, and the merges into one game repo one at a
 * time. With `alone`, a check with performance also runs while no other check runs (`checkGate`).
 */
export interface RegressPool {
  /** One piece of work: at most `regress.parallel` run at once. */
  work<T>(fn: () => Promise<T>): Promise<T>;
  /** A check, as `work`; with `alone`, one with performance runs while no other check runs. */
  check<T>(performance: boolean, fn: () => Promise<T>): Promise<T>;
  /** A merge into the game repo `game`, as `work`, after the merges into it that came before. */
  merge<T>(game: string, fn: () => Promise<T>): Promise<T>;
}

export function regressPool(parallel: number, alone = false): RegressPool {
  const slots = limiter(parallel);
  const gate = alone ? checkGate() : null;
  const merges = new Map<string, Limiter>();
  return {
    work: (fn) => slots.run(fn),
    check: (performance, fn) => (gate === null ? slots.run(fn) : gate.run(performance, () => slots.run(fn))),
    merge(game, fn) {
      let one = merges.get(game);
      if (one === undefined) {
        one = limiter(1);
        merges.set(game, one);
      }
      // the merge waits for its game before it takes a slot, so that a waiting merge keeps no slot from other work
      return one.run(() => slots.run(fn));
    },
  };
}
