import { conditionProblems, isRecord } from './scenario-form.ts';

/**
 * Bot playtest condition (`client-content` `## bot playtest`):
 * `{"path", "op", "value"}` or `{"all": [<condition>, ...]}`.
 */
export type Condition = { path: string; op: 'eq' | 'ne' | 'gte' | 'lte' | 'count_gte'; value: unknown } | { all: Condition[] };

/** Returns the condition when it has the defined form (`scenario-form.ts`), else an English reason. */
export function parseCondition(value: unknown): Condition | string {
  const problem = conditionProblems(value, '')[0];
  return problem === undefined ? (value as Condition) : problem[1];
}

/** True when some leaf of the condition reads `telemetry.`. */
export function needsTelemetry(condition: Condition): boolean {
  if ('all' in condition) return condition.all.some(needsTelemetry);
  return condition.path.startsWith('telemetry.');
}

const MISSING = Symbol('missing');

function lookup(root: unknown, names: readonly string[]): unknown {
  let current: unknown = root;
  for (const name of names) {
    if (!isRecord(current) || !Object.hasOwn(current, name)) return MISSING;
    current = current[name];
  }
  return current;
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

function compare(found: unknown, op: string, value: unknown): boolean {
  switch (op) {
    case 'eq':
      return jsonEqual(found, value);
    case 'ne':
      return !jsonEqual(found, value);
    case 'gte':
      return typeof found === 'number' && typeof value === 'number' && found >= value;
    case 'lte':
      return typeof found === 'number' && typeof value === 'number' && found <= value;
    default:
      return Array.isArray(found) && typeof value === 'number' && found.length >= value;
  }
}

/** Evaluates a condition on `get_state` and `get_telemetry` results. A missing path is false. */
export function evaluate(condition: Condition, sources: { state: unknown; telemetry: unknown }): boolean {
  if ('all' in condition) return condition.all.every((item) => evaluate(item, sources));
  const [root, ...names] = condition.path.split('.');
  const found = lookup(root === 'state' ? sources.state : sources.telemetry, names);
  if (found === MISSING) return false;
  return compare(found, condition.op, condition.value);
}
