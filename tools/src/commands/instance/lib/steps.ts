import { setTimeout as sleep } from 'node:timers/promises';
import { OgwError } from '../../../lib/errors.ts';
import { isPlainObject } from '../../../lib/json.ts';
import type { ChannelResponse } from './channel.ts';
import type { FixtureStep } from './records.ts';

/** Sends one automation channel request to one client. */
export type Requester = (command: string, args: readonly string[], timeoutMs: number) => Promise<ChannelResponse>;

/** The save fixture is not valid, or a save fixture step (or the restart after the steps) failed. */
export class FixtureError extends OgwError {}

/** Interval of `get_state` polling while waiting for a state. */
export const POLL_MS = 200;

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

function lookup(root: unknown, path: readonly string[]): { found: boolean; value: unknown } {
  let value = root;
  for (const part of path) {
    if (!isPlainObject(value) || !(part in value)) return { found: false, value: undefined };
    value = value[part];
  }
  return { found: true, value };
}

function compare(op: unknown, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'eq':
      return deepEqual(actual, expected);
    case 'ne':
      return !deepEqual(actual, expected);
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'count_gte':
      return Array.isArray(actual) && typeof expected === 'number' && actual.length >= expected;
    default:
      throw new OgwError(`invalid condition op: ${String(op)}`);
  }
}

/** Evaluates a scenario condition (client-content `## bot playtest`) on `get_state` and `get_telemetry` results. */
export function evalCondition(condition: unknown, state: unknown, telemetry: unknown): boolean {
  if (!isPlainObject(condition)) throw new OgwError('invalid condition');
  if (Array.isArray(condition.all)) return condition.all.every((c) => evalCondition(c, state, telemetry));
  if (typeof condition.path !== 'string') throw new OgwError('invalid condition: no path');
  const [root, ...rest] = condition.path.split('.');
  const source = root === 'state' ? state : root === 'telemetry' ? telemetry : null;
  if (source === null) throw new OgwError(`invalid condition path: ${condition.path}`);
  const { found, value } = lookup(source, rest);
  return found && compare(condition.op, value, condition.value);
}

function usesTelemetry(condition: unknown): boolean {
  if (!isPlainObject(condition)) return false;
  if (Array.isArray(condition.all)) return condition.all.some(usesTelemetry);
  return typeof condition.path === 'string' && condition.path.startsWith('telemetry.');
}

/** `get_state` result; fails when the request fails. */
export async function getState(request: Requester, timeoutMs: number): Promise<Record<string, unknown>> {
  const response = await request('get_state', [], timeoutMs);
  if (!response.ok || !isPlainObject(response.result)) throw new OgwError(`get_state failed: ${JSON.stringify(response.result)}`);
  return response.result;
}

/** Waits until `boot_stage` is `Done`. Fails when it is `Halted` or the time passes. */
export async function waitBootDone(request: Requester, timeoutMs: number, commandTimeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new OgwError(`boot_stage did not reach Done within ${String(timeoutMs)} ms`);
    const state = await getState(request, Math.min(left, commandTimeoutMs));
    if (state.boot_stage === 'Done') return state;
    if (state.boot_stage === 'Halted') throw new OgwError('boot_stage is Halted');
    await sleep(POLL_MS);
  }
}

/** Waits until `condition` is true; fails when the time passes. */
export async function waitCondition(request: Requester, condition: unknown, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const withTelemetry = usesTelemetry(condition);
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new OgwError(`condition not reached within ${String(timeoutMs)} ms: ${JSON.stringify(condition)}`);
    const state = await getState(request, left);
    let telemetry: unknown = null;
    if (withTelemetry) {
      const response = await request('get_telemetry', [], Math.max(1, deadline - Date.now()));
      telemetry = response.ok ? response.result : null;
    }
    if (evalCondition(condition, state, telemetry)) return;
    await sleep(POLL_MS);
  }
}

/** Runs one step: the command, then waits for `until` when it has one. The whole step has `timeoutMs`. */
export async function runStep(request: Requester, step: FixtureStep, index: number): Promise<void> {
  const deadline = Date.now() + step.timeoutMs;
  const response = await request(step.command, step.args, step.timeoutMs).catch((error: unknown) => {
    throw new OgwError(`step ${String(index + 1)} (${step.command}) failed: ${(error as Error).message}`);
  });
  if (!response.ok) {
    throw new OgwError(`step ${String(index + 1)} (${step.command}) failed: ${JSON.stringify(response.result)}`);
  }
  if (step.until === null || step.until === undefined) return;
  await waitCondition(request, step.until, Math.max(0, deadline - Date.now())).catch((error: unknown) => {
    throw new OgwError(`step ${String(index + 1)} (${step.command}) failed: ${(error as Error).message}`);
  });
}

function stepError(index: number, what: string): OgwError {
  return new FixtureError(`invalid save fixture: step ${String(index + 1)} ${what}`);
}

function readStep(value: unknown, index: number): FixtureStep {
  if (!isPlainObject(value)) throw stepError(index, 'is not an object');
  if (value.kind !== 'setup') throw stepError(index, 'kind is not setup');
  if (typeof value.command !== 'string' || value.command === '') throw stepError(index, 'has no command');
  const args = value.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw stepError(index, 'args is not a list of strings');
  if (typeof value.timeoutMs !== 'number' || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1) {
    throw stepError(index, 'timeoutMs is not an integer of 1 or more');
  }
  return { kind: 'setup', command: value.command, args, until: value.until ?? null, timeoutMs: value.timeoutMs };
}

/** Reads a save fixture `{"steps": [<step>, ...]}` whose steps are all `setup` steps. */
export function parseFixture(text: string): FixtureStep[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FixtureError('invalid save fixture: not JSON');
  }
  if (!isPlainObject(value) || !Array.isArray(value.steps)) throw new FixtureError('invalid save fixture: no steps');
  return value.steps.map(readStep);
}
