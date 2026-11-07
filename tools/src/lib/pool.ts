/** How many file reads or writes one loop of `ogw` keeps going at once: more than the 4 threads of libuv, which queue the rest. */
export const FILE_IO = 16;

/** How many short git processes one loop of `ogw` keeps going at once. */
export const GIT_PROCESSES = 8;

/**
 * `work` of each item, at most `limit` at a time, a finished one starting the next; the results keep the order of the
 * items. Once a work item fails no other starts, and when the started ones have ended, the failure of the first failed
 * item in order is thrown, as running them one after another would throw it.
 */
export async function pooled<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const failures: { index: number; error: unknown }[] = [];
  let next = 0;
  const lane = async (): Promise<void> => {
    while (failures.length === 0 && next < items.length) {
      const index = next++;
      try {
        results[index] = await work(items[index] as T, index);
      } catch (error) {
        failures.push({ index, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  const [first] = failures.sort((a, b) => a.index - b.index);
  if (first !== undefined) throw first.error;
  return results;
}

type Outcome<R> = { value: R } | { error: unknown };

/**
 * `take` of the result of `work` of each item, in the order of the items, one at a time; the work of the next `ahead`
 * items runs while `take` waits for or takes one, so that no more than that many results are held. The failure of a
 * work item is thrown when its turn comes, and no later item is taken.
 */
export async function inOrder<T, R>(items: readonly T[], ahead: number, work: (item: T) => Promise<R>, take: (result: R, item: T) => void | Promise<void>): Promise<void> {
  const started = new Map<number, Promise<Outcome<R>>>();
  const start = (index: number): void => {
    if (index >= items.length || started.has(index)) return;
    started.set(index, work(items[index] as T).then((value) => ({ value }), (error: unknown) => ({ error })));
  };
  try {
    for (const [index, item] of items.entries()) {
      for (let k = index; k < index + Math.max(1, ahead); k++) start(k);
      const outcome = await (started.get(index) as Promise<Outcome<R>>);
      started.delete(index);
      if ('error' in outcome) throw outcome.error;
      await take(outcome.value, item);
    }
  } finally {
    // the work started ahead of a failure ends before the failure is thrown
    await Promise.all(started.values());
  }
}
