import { describe, expect, it } from 'vitest';
import { rowProblems } from '../../../../src/commands/measure/lib/targets.ts';

const row = (metric: string, min: string, max: string) => ({ line: 1, metric, min, max, data: '' });

describe('rowProblems', () => {
  it('takes decimals only for the metrics whose values are decimals', () => {
    expect(rowProblems(row('feedback_share', '0.5', '1'))).toEqual([]);
    expect(rowProblems(row('feedback_per_input', '0.25', '1.5'))).toEqual([]);
    expect(rowProblems(row('feedback_share', '0.9', '0.5'))).toEqual(['min 0.9 of `feedback_share` is greater than max 0.5']);
    expect(rowProblems(row('feedback_share', 'x', '1'))).toEqual(['min `x` of `feedback_share` is not a number']);
    expect(rowProblems(row('goal_interval_ms', '0.5', '10'))).toEqual(['min `0.5` of `goal_interval_ms` is not an integer']);
  });
});
