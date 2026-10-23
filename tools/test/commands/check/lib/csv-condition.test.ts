import { describe, expect, it } from 'vitest';
import { evaluate, jsonEqual, needsTelemetry, parseCondition } from '../../../../src/commands/check/lib/condition.ts';
describe('condition', () => {
  const sources = {
    state: { boot_stage: 'Done', tutorial: { id: 'N' }, count: 3, list: [1, 2] },
    telemetry: { goal_intervals: [{}, {}] },
  };

  it('parses leaves and all, and rejects other forms', () => {
    expect(parseCondition({ path: 'state.a', op: 'eq', value: 1 })).toEqual({ path: 'state.a', op: 'eq', value: 1 });
    expect(parseCondition({ all: [{ path: 'telemetry.x', op: 'count_gte', value: 1 }] })).toEqual({
      all: [{ path: 'telemetry.x', op: 'count_gte', value: 1 }],
    });
    expect(parseCondition(null)).toBe('condition is not an object');
    expect(parseCondition([])).toBe('condition is not an object');
    expect(parseCondition({ all: 1 })).toBe('`all` condition must be `{"all": [<condition>, ...]}`');
    expect(parseCondition({ all: [], path: 'state.a' })).toBe('`all` condition must be `{"all": [<condition>, ...]}`');
    expect(parseCondition({ all: [{ path: 'x', op: 'eq', value: 1 }] })).toBe('condition `path` must start with `state.` or `telemetry.`');
    expect(parseCondition({ path: 3, op: 'eq', value: 1 })).toBe('condition `path` must start with `state.` or `telemetry.`');
    expect(parseCondition({ path: 'state.a', op: 'gt', value: 1 })).toBe('condition `op` must be one of eq, ne, gte, lte, count_gte');
    expect(parseCondition({ path: 'state.a', op: 3, value: 1 })).toBe('condition `op` must be one of eq, ne, gte, lte, count_gte');
    expect(parseCondition({ path: 'state.a', op: 'eq' })).toBe('condition must have exactly `path`, `op`, `value`');
    expect(parseCondition({ path: 'state.a', op: 'eq', value: 1, extra: 2 })).toBe('condition must have exactly `path`, `op`, `value`');
  });

  it('evaluates every op, nested paths, all, and missing paths as false', () => {
    expect(evaluate({ path: 'state.boot_stage', op: 'eq', value: 'Done' }, sources)).toBe(true);
    expect(evaluate({ path: 'state.tutorial.id', op: 'eq', value: 'N' }, sources)).toBe(true);
    expect(evaluate({ path: 'state.tutorial.id', op: 'ne', value: 'N' }, sources)).toBe(false);
    expect(evaluate({ path: 'state.count', op: 'gte', value: 3 }, sources)).toBe(true);
    expect(evaluate({ path: 'state.count', op: 'gte', value: 4 }, sources)).toBe(false);
    expect(evaluate({ path: 'state.count', op: 'lte', value: 3 }, sources)).toBe(true);
    expect(evaluate({ path: 'state.count', op: 'lte', value: 2 }, sources)).toBe(false);
    expect(evaluate({ path: 'state.boot_stage', op: 'gte', value: 1 }, sources)).toBe(false);
    expect(evaluate({ path: 'state.boot_stage', op: 'lte', value: 1 }, sources)).toBe(false);
    expect(evaluate({ path: 'telemetry.goal_intervals', op: 'count_gte', value: 2 }, sources)).toBe(true);
    expect(evaluate({ path: 'telemetry.goal_intervals', op: 'count_gte', value: 3 }, sources)).toBe(false);
    expect(evaluate({ path: 'state.count', op: 'count_gte', value: 0 }, sources)).toBe(false);
    expect(evaluate({ path: 'state.missing', op: 'ne', value: 1 }, sources)).toBe(false);
    expect(evaluate({ path: 'state.constructor', op: 'ne', value: null }, { state: {}, telemetry: null })).toBe(false);
    expect(evaluate({ path: 'state.toString', op: 'ne', value: null }, { state: {}, telemetry: null })).toBe(false);
    expect(evaluate({ path: 'state.count.deeper', op: 'eq', value: 1 }, sources)).toBe(false);
    expect(evaluate({ path: 'state.list', op: 'eq', value: [1, 2] }, sources)).toBe(true);
    const both = { all: [{ path: 'state.count', op: 'eq' as const, value: 3 }, { path: 'state.count', op: 'eq' as const, value: 4 }] };
    expect(evaluate(both, sources)).toBe(false);
    expect(evaluate({ all: [] }, sources)).toBe(true);
  });

  it('needsTelemetry looks into all', () => {
    expect(needsTelemetry({ path: 'state.a', op: 'eq', value: 1 })).toBe(false);
    expect(needsTelemetry({ all: [{ path: 'state.a', op: 'eq', value: 1 }, { path: 'telemetry.b', op: 'eq', value: 1 }] })).toBe(true);
  });

  it('jsonEqual compares JSON values deeply', () => {
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual({ a: 1, c: 1 }, { a: 1, b: 1 })).toBe(false);
    expect(jsonEqual([1, 2], [1, 3])).toBe(false);
    expect(jsonEqual([1], [1, 2])).toBe(false);
    expect(jsonEqual([1], { 0: 1 })).toBe(false);
    expect(jsonEqual(1, '1')).toBe(false);
  });
});
