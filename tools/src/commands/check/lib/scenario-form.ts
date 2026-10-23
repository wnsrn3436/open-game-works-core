/**
 * The form of a bot playtest scenario and save fixture (`client-content` `## bot playtest`): one set of rules for the
 * runtime parse (`parseScenario`) and static check `bot scenario`. Rules that need the `QACore` built-in command list
 * stay in the static check.
 */
import { isRecord } from '../static/lib/json-pos.ts';

/** A problem: the JSON pointer of the value it is about and an English message. */
export type FormProblem = [pointer: string, message: string];

const STEP_FIELDS = new Set(['kind', 'command', 'args', 'until', 'timeoutMs', 'social']);
export const STEP_KINDS: ReadonlySet<string> = new Set(['input', 'setup', 'auto', 'save']);
export const CONDITION_OPS: ReadonlySet<string> = new Set(['eq', 'ne', 'gte', 'lte', 'count_gte']);
export const SOCIAL_MODULES: readonly string[] = ['friend', 'guild', 'chat'];
/** The message of a scenario without `goal`. */
export const NO_GOAL = 'no `goal`';

export { isRecord };

/** Problems of a condition `{"path", "op", "value"}` or `{"all": [<condition>, ...]}`; empty when it is valid. */
export function conditionProblems(cond: unknown, pointer: string): FormProblem[] {
  if (!isRecord(cond)) return [[pointer, 'condition is not an object']];
  if ('all' in cond) {
    if (Object.keys(cond).length !== 1 || !Array.isArray(cond.all)) return [[pointer, '`all` condition must be `{"all": [<condition>, ...]}`']];
    return cond.all.flatMap((c, i) => conditionProblems(c, `${pointer}/all/${String(i)}`));
  }
  const keys = Object.keys(cond).sort().join(',');
  if (keys !== 'op,path,value') return [[pointer, 'condition must have exactly `path`, `op`, `value`']];
  const out: FormProblem[] = [];
  if (typeof cond.path !== 'string' || !/^(state|telemetry)\.[^.]+/.test(cond.path)) out.push([pointer, 'condition `path` must start with `state.` or `telemetry.`']);
  if (typeof cond.op !== 'string' || !CONDITION_OPS.has(cond.op)) out.push([pointer, `condition \`op\` must be one of ${[...CONDITION_OPS].join(', ')}`]);
  return out;
}

/** Problems of one step's form; the command itself is not looked up. */
export function stepProblems(step: unknown, pointer: string): FormProblem[] {
  if (!isRecord(step)) return [[pointer, 'step is not an object']];
  const out: FormProblem[] = [];
  const unknown = Object.keys(step).filter((k) => !STEP_FIELDS.has(k));
  if (unknown.length > 0) out.push([pointer, `unknown step field \`${unknown.join('`, `')}\``]);
  if (typeof step.kind !== 'string' || !STEP_KINDS.has(step.kind)) {
    out.push([pointer, '`kind` must be `input`, `setup`, `auto` or `save`']);
    return out;
  }
  if (step.kind === 'save' && step.command !== undefined) out.push([pointer, '`save` step has a `command`']);
  if (step.kind !== 'save' && typeof step.command !== 'string') out.push([pointer, 'step has no `command`']);
  out.push(...fieldProblems(step, pointer));
  return out;
}

/** Problems of the step fields other than `kind` and `command`. */
function fieldProblems(step: Record<string, unknown>, pointer: string): FormProblem[] {
  const out: FormProblem[] = [];
  if (step.args !== undefined && (!Array.isArray(step.args) || !step.args.every((a) => typeof a === 'string'))) out.push([pointer, '`args` must be a list of strings']);
  if (step.until !== undefined) out.push(...conditionProblems(step.until, `${pointer}/until`));
  else if (step.kind === 'auto') out.push([pointer, '`auto` step has no `until`']);
  if (typeof step.timeoutMs !== 'number' || !Number.isInteger(step.timeoutMs) || step.timeoutMs < 1) out.push([pointer, '`timeoutMs` must be an integer of 1 or more']);
  if (step.social !== undefined && !SOCIAL_MODULES.includes(step.social as string)) out.push([pointer, '`social` must be `friend`, `guild` or `chat`']);
  return out;
}

/** Problems of a parsed scenario JSON value; a missing `goal` is the problem `NO_GOAL` at pointer ``. */
export function scenarioProblems(value: unknown): FormProblem[] {
  if (!isRecord(value)) return [['', 'scenario is not a JSON object']];
  const out: FormProblem[] = [];
  const extra = Object.keys(value).filter((k) => k !== 'steps' && k !== 'goal');
  if (extra.length > 0) out.push(['', `unknown field \`${extra.join('`, `')}\``]);
  if (!Array.isArray(value.steps)) out.push(['', '`steps` is not a list']);
  else value.steps.forEach((s: unknown, i: number) => out.push(...stepProblems(s, `/steps/${String(i)}`)));
  if (value.goal === undefined) out.push(['', NO_GOAL]);
  else out.push(...conditionProblems(value.goal, '/goal'));
  return out;
}

/** Where a pointer is, in words: `scenario`, `step <n>`, `step <n> until`, `goal`. */
export function pointerText(pointer: string): string {
  const step = /^\/steps\/(\d+)(\/until.*)?$/.exec(pointer);
  if (step) return `step ${String(Number(step[1]) + 1)}${step[2] === undefined ? '' : ' until'}`;
  if (pointer.startsWith('/goal')) return 'goal';
  return 'scenario';
}
