import { expectPositionals, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { openHeadless } from '../build/lib/chromium.ts';
import { toolProgram } from './api.ts';
import { benchmarkValues, median } from './lib/benchmark.ts';
import { writeEnvResult } from './lib/results.ts';

/** `ogw env benchmark` (ogw.md `## env benchmark`): the benchmark index of this host in the headless browser of `tools.chromium`. */
export const benchmarkCommand: CommandDef = {
  name: ['env', 'benchmark'],
  usage: 'ogw env benchmark',
  async run(ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    const chromium = await toolProgram(ctx, 'chromium');
    if (chromium === null) throw new OgwError('harness settings tools.chromium is not on this host: ogw generation install gets it');
    const measuredAt = Date.now();
    const page = await openHeadless(ctx, chromium, 'about:blank', 1);
    let values: number[];
    try {
      values = await benchmarkValues(page);
    } finally {
      await page.close();
    }
    const index = median(values);
    const file = await writeEnvResult(ctx, 'env-benchmark', { measuredAt, values, index });
    return { text: `benchmark index: ${String(index)} (${values.join(', ')})\nresult: ${file}`, data: { measuredAt, values, index, result: file } };
  },
};
