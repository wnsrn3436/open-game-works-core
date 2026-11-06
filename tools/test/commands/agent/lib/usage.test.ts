import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeUsage, codexUsage, jobUsage, printedUsage, sessionUsageOf, withResultText } from '../../../../src/commands/agent/lib/usage.ts';

/**
 * Real output of the two agent CLIs on this host: `claude -p --output-format json` (Claude Code 2.1.296) and
 * `codex exec --json` (codex-cli 0.164.0, ChatGPT login), each with one short prompt.
 */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '..', '..', '..', 'fixtures', 'agent-usage', name), 'utf8');
}

const CLAUDE = { cli: 'claude-code' as const, model: 'claude-haiku-4-5', effort: 'low' };
const CODEX = { cli: 'codex' as const, model: 'gpt-5.5', effort: 'low' };

describe('agent usage: Claude Code', () => {
  it('reads the tokens summed over the models, the cost and the turns of the result object', () => {
    expect(claudeUsage(fixture('claude-result.json'))).toEqual({ inputTokens: 9 + 9278 + 22611, cachedTokens: 22611, outputTokens: 63, costUsd: 0.0211411, turns: 1 });
  });

  it('counts the tokens of every model of the run, a helper agent included, as its cost does', () => {
    // `usage` holds one request of the main model; `modelUsage` holds the main model and the helper agent's model
    const usage = claudeUsage(fixture('claude-helper-agent.json'));
    expect(usage).toEqual({ inputTokens: 8 + 13292 + 89121 + (2 + 25338 + 0), cachedTokens: 89121, outputTokens: 121 + 4, costUsd: 0.06647555, turns: 1 });
  });

  it('takes the last result object of the log, after stderr lines and a line the agent wrote', () => {
    const fake = JSON.stringify({ type: 'result', total_cost_usd: 99, num_turns: 9, modelUsage: {} });
    const log = `warning: something\n${fake}\n{not json\n${fixture('claude-result.json').trim()}\nstderr after\n`;
    expect(claudeUsage(log)?.costUsd).toBe(0.0211411);
    expect(claudeUsage('only text\n')).toBeNull();
    expect(claudeUsage('')).toBeNull();
  });

  it('gives null for a count or cost the result object lacks', () => {
    const log = JSON.stringify({ type: 'result', num_turns: 2, modelUsage: { m: { inputTokens: 1, outputTokens: 2 } } });
    expect(claudeUsage(log)).toEqual({ inputTokens: null, cachedTokens: null, outputTokens: 2, costUsd: null, turns: 2 });
  });

  it('takes the job of a resumed session as the session totals minus those the earlier job of the session printed', () => {
    // the second run resumed the session of the first: Claude Code printed the totals of both runs
    const first = claudeUsage(fixture('claude-session-new.json'));
    const second = claudeUsage(fixture('claude-session-resumed.json'));
    expect(first).toEqual({ inputTokens: 9 + 4499 + 26720, cachedTokens: 26720, outputTokens: 63, costUsd: 0.011994000000000001, turns: 1 });
    expect(second).toMatchObject({ inputTokens: 18 + 5348 + 57939, cachedTokens: 57939, outputTokens: 112, costUsd: 0.0170679, turns: 1 });
    if (first === null || second === null) throw new Error('no result object');
    const own = jobUsage(CLAUDE, second, true, sessionUsageOf(first));
    expect(own).toMatchObject({ cli: 'claude-code', model: 'claude-haiku-4-5', effort: 'low', inputTokens: 32077, cachedTokens: 31219, outputTokens: 49, turns: 1 });
    expect(own.costUsd).toBeCloseTo(0.0050739, 10);
    // a new session: the printed values
    expect(jobUsage(CLAUDE, first, false, null)).toEqual({ ...CLAUDE, ...first });
    // no earlier session usage, or a negative difference: unknown
    expect(jobUsage(CLAUDE, second, true, null)).toMatchObject({ inputTokens: null, cachedTokens: null, outputTokens: null, costUsd: null, turns: 1 });
    expect(jobUsage(CLAUDE, first, true, sessionUsageOf(second))).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null });
  });

  it('shows the result object of a failure tail as its result text', () => {
    const text = `before\n${fixture('claude-result.json').trim()}\nafter`;
    expect(withResultText(text)).toBe("before\nOk, I'm ready to help! What would you like to work on?\nafter");
    expect(withResultText('{"type":"result","result":null}\nplain')).toBe('{"type":"result","result":null}\nplain');
  });
});

describe('agent usage: Codex', () => {
  it('reads the tokens of the last turn.completed event, with no cost and no turn count', () => {
    expect(codexUsage(fixture('codex.jsonl'))).toEqual({ inputTokens: 16552, cachedTokens: 13312, outputTokens: 5, costUsd: null, turns: null });
    expect(codexUsage(fixture('codex-command.jsonl'))).toEqual({ inputTokens: 33201, cachedTokens: 23552, outputTokens: 51, costUsd: null, turns: null });
    expect(printedUsage('codex', `Reading additional input from stdin...\n${fixture('codex.jsonl')}`)?.inputTokens).toBe(16552);
  });

  it('gives no usage for a turn that failed before it completed', () => {
    expect(codexUsage(fixture('codex-failed.jsonl'))).toBeNull();
    expect(jobUsage(CODEX, null, false, null)).toEqual({ ...CODEX, inputTokens: null, cachedTokens: null, outputTokens: null, costUsd: null, turns: null });
  });

  it('reads each CLI only by its own output', () => {
    expect(printedUsage('claude-code', fixture('codex.jsonl'))).toBeNull();
    expect(printedUsage('codex', fixture('claude-result.json'))).toBeNull();
  });
});
