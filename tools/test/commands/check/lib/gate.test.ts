import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../../../../src/commands/check/api.ts';
import { CHECK_ORDER, gateOf } from '../../../../src/commands/check/lib/loop.ts';

function check(name: string, result: CheckResult['result'], platform: string | null = null): CheckResult {
  return { name, platform, result, failures: [], warnings: [] };
}

/** One passing item per check, `performance` and `UI quality` on two platforms. */
function allPass(): CheckResult[] {
  return CHECK_ORDER.flatMap((name) => (name === 'performance' || name === 'UI quality' ? [check(name, 'pass', 'ios'), check(name, 'pass', 'web')] : [check(name, 'pass')]));
}

function withResult(name: string, result: CheckResult['result']): CheckResult[] {
  return allPass().map((c) => (c.name === name ? { ...c, result } : c));
}

describe('gateOf', () => {
  it('passes when regression test, static check, no blocker and full flow all pass', () => {
    expect(gateOf(allPass())).toBe('pass');
  });

  it('fails when any one gate check is fail or unknown', () => {
    for (const name of ['regression test', 'static check', 'no blocker', 'full flow']) {
      expect(gateOf(withResult(name, 'fail'))).toBe('fail');
      expect(gateOf(withResult(name, 'unknown'))).toBe('fail');
    }
  });

  it('fails when a gate check is missing', () => {
    expect(gateOf(allPass().filter((c) => c.name !== 'full flow'))).toBe('fail');
  });

  it('stays pass when only a check outside the gate fails or is unknown', () => {
    for (const name of ['performance', 'UI quality', 'no placeholder', 'row simulation']) {
      expect(gateOf(withResult(name, 'fail'))).toBe('pass');
      expect(gateOf(withResult(name, 'unknown'))).toBe('pass');
    }
    const oneWeb = allPass().map((c) => (c.name === 'performance' && c.platform === 'web' ? { ...c, result: 'fail' as const } : c));
    expect(gateOf(oneWeb)).toBe('pass');
  });
});
