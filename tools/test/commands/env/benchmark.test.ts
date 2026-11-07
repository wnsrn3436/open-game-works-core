import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toolProgram } from '../../../src/commands/env/api.ts';
import { BENCHMARK_RUNS, BENCHMARK_SCRIPT, benchmarkValues, median, throttleRate } from '../../../src/commands/env/lib/benchmark.ts';
import { makeWorkspace, ogw, type TestWorkspace } from '../../helpers/workspace.ts';

vi.mock('../../../src/commands/env/api.ts', async (orig) => ({ ...(await orig<object>()), toolProgram: vi.fn() }));

const fakes = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'fakes');

let ws: TestWorkspace;
let bin: string;

beforeEach(() => {
  ws = makeWorkspace();
  bin = join(ws.root, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'chromium'), `#!/bin/sh\nexec "${process.execPath}" "${join(fakes, 'fake-chromium.ts')}" "$@"\n`, { mode: 0o755 });
  vi.mocked(toolProgram).mockReset().mockResolvedValue(join(bin, 'chromium'));
});

describe('benchmark index', () => {
  it('measures the mean of the string score and the array score in a page', () => {
    const index = runInNewContext(BENCHMARK_SCRIPT, { Date, Math, Error }) as unknown;
    expect(typeof index).toBe('number');
    expect(index as number).toBeGreaterThan(0);
    // a clock that moves 1 ms per reading: 499 strings in 0.501 s score 100, 4990 copies (the clock read every 10th) score 996
    let now = 0;
    expect(runInNewContext(BENCHMARK_SCRIPT, { Date: { now: () => ++now }, Math, Error })).toBe(548);
  });

  it('takes the median of five runs and refuses a value that is not a positive number', async () => {
    expect(BENCHMARK_RUNS).toBe(5);
    const page = (values: unknown[]): { evaluate: () => Promise<unknown> } => ({ evaluate: () => Promise.resolve(values.shift()) });
    expect(await benchmarkValues(page([5, 1, 4, 2, 3]))).toEqual([5, 1, 4, 2, 3]);
    expect(median([5, 1, 4, 2, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    await expect(benchmarkValues(page([5, 0, 4, 2, 3]))).rejects.toThrow('the benchmark gave 0, not a positive number');
    await expect(benchmarkValues(page([5, 'x']))).rejects.toThrow('the benchmark gave "x", not a positive number');
  });

  it('gives the throttle factor of this host against the device, rounded and at least 1', () => {
    expect(throttleRate(1752, 438)).toBe(4);
    expect(throttleRate(4400, 438)).toBe(10);
    expect(throttleRate(4600, 438)).toBe(11);
    expect(throttleRate(300, 438)).toBe(1);
  });
});

describe('ogw env benchmark', () => {
  it('measures the benchmark index in about:blank of the headless browser without throttle and writes the median', async () => {
    const env = { FAKE_DIR: bin, FAKE_CHROMIUM_EVAL: JSON.stringify([4300, 4500, 4400, 4100, 4450]) };
    const run = await ogw(ws, ['env', 'benchmark', '--json'], { env });
    expect(run.stderr).toBe('');
    const out = JSON.parse(run.stdout) as { values: number[]; index: number; result: string; measuredAt: number };
    expect(out).toMatchObject({ values: [4300, 4500, 4400, 4100, 4450], index: 4400 });
    expect(out.result).toBe(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'env-benchmark.json'));
    expect(JSON.parse(readFileSync(out.result, 'utf8'))).toEqual({ measuredAt: out.measuredAt, values: [4300, 4500, 4400, 4100, 4450], index: 4400 });
    const calls = readFileSync(join(bin, 'chromium.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    expect(calls.find((c) => c.method === 'Emulation.setCPUThrottlingRate')?.params).toEqual({ rate: 1 });
    expect(calls.find((c) => c.method === 'Page.navigate')?.params).toEqual({ url: 'about:blank' });
    const scripts = calls.filter((c) => c.method === 'Runtime.evaluate');
    expect(scripts).toHaveLength(5);
    expect(scripts.every((c) => c.params?.expression === BENCHMARK_SCRIPT)).toBe(true);
  });

  it('fails without tools.chromium on this host or with a failed run, and writes no result', async () => {
    vi.mocked(toolProgram).mockResolvedValue(null);
    expect(await ogw(ws, ['env', 'benchmark'])).toEqual({ code: 1, stdout: '', stderr: 'harness settings tools.chromium is not on this host: ogw generation install gets it\n' });
    vi.mocked(toolProgram).mockResolvedValue(join(bin, 'chromium'));
    const failed = await ogw(ws, ['env', 'benchmark'], { env: { FAKE_DIR: bin, FAKE_CHROMIUM_EVAL: JSON.stringify([4300, { throw: 'RangeError: x' }]) } });
    expect(failed).toMatchObject({ code: 1, stderr: 'page script failed: RangeError: x\n' });
    expect(() => readFileSync(join(ws.harness, '.git', 'ogw-temp', 'ogw-env', 'env-benchmark.json'))).toThrow();
  });
});
