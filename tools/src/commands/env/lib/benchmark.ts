import { OgwError } from '../../../lib/errors.ts';

/**
 * The page script whose value is the benchmark index of the page (ogw.md `## env benchmark`): the mean of a string
 * building score and an array copying score, each the count divided by 10 and by the seconds taken, rounded.
 */
export const BENCHMARK_SCRIPT = `(() => {
  const strings = () => {
    const start = Date.now();
    let count = 0;
    while (Date.now() - start < 500) {
      let text = '';
      for (let i = 0; i < 10000; i++) text += 'a';
      if (text.length !== 10000) throw new Error('the string has the wrong length');
      count++;
    }
    return Math.round(count / 10 / ((Date.now() - start) / 1000));
  };
  const copies = () => {
    const a = [];
    const b = [];
    for (let i = 0; i < 100000; i++) a[i] = b[i] = i;
    const start = Date.now();
    let count = 0;
    while (count % 10 !== 0 || Date.now() - start < 500) {
      const from = count % 2 === 0 ? a : b;
      const to = count % 2 === 0 ? b : a;
      for (let i = 0; i < from.length; i++) to[i] = from[i];
      count++;
    }
    return Math.round(count / 10 / ((Date.now() - start) / 1000));
  };
  const first = strings();
  return (first + copies()) / 2;
})()`;

/** Measurements of the benchmark index in one page. */
export const BENCHMARK_RUNS = 5;

/** A page that runs a script and gives its value. */
export interface ScriptPage {
  evaluate(expression: string): Promise<unknown>;
}

/** The median of `values`: the middle one of an odd count, the mean of the middle two of an even count. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) throw new OgwError('no value to take the median of');
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** `BENCHMARK_RUNS` benchmark indexes measured one after another in `page`; fails on a value that is not a positive number. */
export async function benchmarkValues(page: ScriptPage): Promise<number[]> {
  const values: number[] = [];
  for (let i = 0; i < BENCHMARK_RUNS; i++) {
    const value = await page.evaluate(BENCHMARK_SCRIPT);
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new OgwError(`the benchmark gave ${JSON.stringify(value)}, not a positive number`);
    values.push(value);
  }
  return values;
}

/**
 * The throttle factor that makes this host run at the speed of the device (ogw.md `## env propose`): its benchmark
 * index divided by the benchmark index of the device, rounded, and at least 1.
 */
export function throttleRate(hostIndex: number, deviceIndex: number): number {
  return Math.max(1, Math.round(hostIndex / deviceIndex));
}
