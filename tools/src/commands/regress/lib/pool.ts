/** Runs `work` over `items`, at most `limit` at a time, keeping the order of the results. */
export async function pooled<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index] as T, index);
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * The checks of one `ogw regress` command (ogw.md `## regress`): a check with performance runs while no other check
 * runs. It starts once the checks running have ended, and a check that comes while it waits starts after it, so that
 * checks without performance that start beside each other do not keep it out.
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
