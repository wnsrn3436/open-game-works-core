import { describe, expect, it } from 'vitest';
import { costRows, renderCost } from '../../../../src/commands/loop/lib/cost.ts';
import type { JobRecord } from '../../../../src/lib/jobs.ts';

function job(role: string, usage: Record<string, unknown> | null): JobRecord {
  return {
    id: `j-${role}`,
    argv: [],
    cwd: '/',
    command: 'agent',
    game: 'g',
    startedAt: 1,
    endedAt: null,
    status: 'done',
    exitCode: 0,
    supervisorPid: null,
    pid: null,
    timeLimitMs: 1,
    agentJob: null,
    summary: null,
    meta: { role, ...(usage === null ? {} : { usage }) },
  };
}

const claude = (input: number, cached: number, output: number, cost: number | null): Record<string, unknown> => ({
  cli: 'claude-code', model: 'm', effort: 'high', inputTokens: input, cachedTokens: cached, outputTokens: output, costUsd: cost, turns: 3,
});
const codex = { cli: 'codex', model: 'gpt-x', effort: 'low', inputTokens: 100, cachedTokens: 40, outputTokens: 7, costUsd: null, turns: null };
const printedNone = { cli: 'claude-code', model: 'm', effort: 'high', inputTokens: null, cachedTokens: null, outputTokens: null, costUsd: null, turns: null };

describe('cost', () => {
  it('sums the usage per role in role order, counting the jobs without usage and without cost', () => {
    const jobs = [
      job('judge', codex),
      job('content', claude(1000, 800, 50, 1.234)),
      job('judge', claude(10, 5, 1, 0.5)),
      job('content', null),
      job('play', printedNone),
    ];
    expect(costRows(jobs, false)).toEqual([
      { role: 'content', jobs: 2, inputTokens: 1000, cachedTokens: 800, outputTokens: 50, costUsd: 1.234, withoutUsage: 1, withoutCost: 1 },
      { role: 'play', jobs: 1, inputTokens: null, cachedTokens: null, outputTokens: null, costUsd: null, withoutUsage: 1, withoutCost: 1 },
      { role: 'judge', jobs: 2, inputTokens: 110, cachedTokens: 45, outputTokens: 8, costUsd: 0.5, withoutUsage: 0, withoutCost: 1 },
    ]);
    expect(costRows(jobs, true).at(-1)).toEqual({ role: 'total', jobs: 5, inputTokens: 1110, cachedTokens: 845, outputTokens: 58, costUsd: 1.734, withoutUsage: 2, withoutCost: 3 });
    expect(renderCost(costRows(jobs, true))).toBe(
      [
        '| role | jobs | input tokens | cached tokens | output tokens | cost USD | without usage | without cost |',
        '|---|---|---|---|---|---|---|---|',
        '| content | 2 | 1000 | 800 | 50 | 1.23 | 1 | 1 |',
        '| play | 1 | none | none | none | none | 1 | 1 |',
        '| judge | 2 | 110 | 45 | 8 | 0.50 | 0 | 1 |',
        '| total | 5 | 1110 | 845 | 58 | 1.73 | 2 | 3 |',
      ].join('\n'),
    );
  });

  it('is none without agent jobs, and has no total row then', () => {
    expect(costRows([], true)).toEqual([]);
    expect(renderCost([])).toBe('none');
  });
});
