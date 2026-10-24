import { expectPositionals, flag, nonNegativeInt, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { captureScreen } from '../capture/capture.ts';
import { automationRequest, botControl, type ClientRef } from '../instance/automation.ts';
import { readPlayAccess } from '../instance/lib/records.ts';
import { readTelemetry } from '../telemetry/api.ts';
import type { Telemetry } from '../telemetry/lib/metrics.ts';

type State = Record<string, unknown>;
type Mark = Telemetry['marks'][number];

/** Telemetry mark kinds that stop the remaining steps of `ogw step --count`. */
export const STOP_MARKS: readonly string[] = ['Fail', 'Reward', 'Goal', 'Restart'];

async function state(ctx: Context, id: string, client: ClientRef): Promise<State> {
  const response = await automationRequest(ctx, id, 'get_state', [], client, { access: 'play' });
  if (!response.ok) throw new OgwError(`${client}: get_state failed: ${JSON.stringify(response.result)}`);
  return (response.result ?? {}) as State;
}

/** Clients `step` goes to: only the client in a `Playing` step-mode match, else every client in step mode. */
async function stepTargets(ctx: Context, id: string, main: State): Promise<ClientRef[]> {
  if (main.step_mode === true && main.match_state === 'Playing') return ['main'];
  const targets: ClientRef[] = main.step_mode === true ? ['main'] : [];
  for (const client of (await readPlayAccess(id, ctx.env)).clients.filter((c) => c !== 'main')) {
    if ((await state(ctx, id, client)).step_mode === true) targets.push(client);
  }
  return targets;
}

const same = (a: Mark, b: Mark): boolean => a.at === b.at && a.play_at === b.play_at && a.kind === b.kind;

/** Marks of `after` that `before` did not have: `after` is a tail of `before` (the oldest dropped) followed by new marks. */
export function newMarks(before: readonly Mark[], after: readonly Mark[]): Mark[] {
  for (let k = Math.min(before.length, after.length); k > 0; k--) {
    const tail = before.slice(before.length - k);
    if (tail.every((mark, i) => same(mark, after[i] as Mark))) return after.slice(k);
  }
  return [...after];
}

const keys = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
const listText = (value: string[]): string => `[${value.join(', ')}]`;

/** Why the remaining steps stop: scene, popup list or panel list changed, or a stop mark appeared. Empty when none. */
export function stopReasons(before: State, after: State, marks: readonly Mark[]): string[] {
  const reasons: string[] = [];
  const scene = (s: State): string => (typeof s.scene_key === 'string' ? s.scene_key : '');
  if (scene(before) !== scene(after)) reasons.push(`scene changed: ${scene(before)} -> ${scene(after)}`);
  for (const field of ['popups', 'panels'] as const) {
    const from = keys(before[field]);
    const to = keys(after[field]);
    if (listText(from) !== listText(to)) reasons.push(`${field} changed: ${listText(from)} -> ${listText(to)}`);
  }
  const kinds = [...new Set(marks.map((m) => m.kind).filter((kind) => STOP_MARKS.includes(kind)))];
  for (const kind of kinds) reasons.push(`mark: ${kind}`);
  return reasons;
}

interface StepRecord {
  index: number;
  /** Game time advanced by this command up to the end of this step. */
  advancedMs: number;
  clients: ClientRef[];
  capture?: string;
}

/** One step: `step` of `ms` to each target client while the bot loops run. Returns the failure lines; empty when it passed. */
async function stepOnce(ctx: Context, id: string, ms: string, targets: ClientRef[]): Promise<string[]> {
  await botControl(ctx, id, 'stepping', { active: true });
  let results: { client: ClientRef; ok: boolean; result: unknown }[];
  try {
    results = await Promise.all(
      targets.map(async (client) => {
        const response = await automationRequest(ctx, id, 'step', [ms], client, { access: 'play' });
        return { client, ok: response.ok, result: response.result };
      }),
    );
  } finally {
    await botControl(ctx, id, 'stepping', { active: false });
  }
  return results.filter((r) => !r.ok).map((r) => `${r.client}: step failed: ${JSON.stringify(r.result)}`);
}

interface Plan {
  id: string;
  ms: string;
  count: number;
  capture: boolean;
}

interface Watch {
  main: State;
  marks: Mark[];
}

type Advance = { errors: string[] } | { record: StepRecord; reasons: string[]; next: Watch | null };

interface Outcome {
  steps: StepRecord[];
  failed?: { index: number; errors: string[] };
  stopped?: { after: number; reasons: string[] };
}

/** Step `index` of the plan, its capture, and unless it is the last step, the stop reasons and the next watch. */
async function advance(ctx: Context, plan: Plan, index: number, watch: Watch): Promise<Advance> {
  const targets = await stepTargets(ctx, plan.id, watch.main);
  if (targets.length === 0) throw new OgwError('no client is in step mode');
  const errors = await stepOnce(ctx, plan.id, plan.ms, targets);
  if (errors.length > 0) return { errors };
  const last = index === plan.count;
  const [path, main, telemetry] = await Promise.all([
    plan.capture ? captureScreen(ctx, plan.id) : undefined,
    last ? undefined : state(ctx, plan.id, 'main'),
    last ? undefined : readTelemetry(ctx, plan.id),
  ]);
  const record: StepRecord = { index, advancedMs: index * Number(plan.ms), clients: targets, ...(path ? { capture: path } : {}) };
  if (main === undefined || telemetry === undefined) return { record, reasons: [], next: null };
  const reasons = stopReasons(watch.main, main, newMarks(watch.marks, telemetry.marks));
  return { record, reasons, next: { main, marks: telemetry.marks } };
}

async function runSteps(ctx: Context, plan: Plan): Promise<Outcome> {
  let watch: Watch = { main: await state(ctx, plan.id, 'main'), marks: plan.count > 1 ? (await readTelemetry(ctx, plan.id)).marks : [] };
  const steps: StepRecord[] = [];
  for (let index = 1; index <= plan.count; index++) {
    let result: Advance;
    try {
      result = await advance(ctx, plan, index, watch);
    } catch (error) {
      // an error in the first step fails the command as one error; after that the passed steps are still reported
      if (index === 1 || !(error instanceof OgwError)) throw error;
      return { steps, failed: { index, errors: [error.message] } };
    }
    if ('errors' in result) return { steps, failed: { index, errors: result.errors } };
    steps.push(result.record);
    if (result.reasons.length > 0) return { steps, stopped: { after: index, reasons: result.reasons } };
    if (result.next !== null) watch = result.next;
  }
  return { steps };
}

function outcomeLines(count: number, outcome: Outcome): string[] {
  const of = (i: number): string => `step ${String(i)}/${String(count)}`;
  const lines = outcome.steps.map(
    (s) => `${of(s.index)}: advanced ${String(s.advancedMs)} ms: ${s.clients.join(', ')}${s.capture !== undefined ? `: ${s.capture}` : ''}`,
  );
  const { failed, stopped } = outcome;
  if (failed) lines.push(...failed.errors.map((e) => `${of(failed.index)}: ${e}`));
  if (stopped) lines.push(`stopped after ${of(stopped.after)}: ${stopped.reasons.join('; ')}`);
  return lines;
}

export const step: CommandDef = {
  name: ['step'],
  usage: 'ogw step <instance> <ms> [--count <n>] [--capture]',
  options: { count: { type: 'string' }, capture: { type: 'boolean' } },
  async run(ctx, args) {
    expectPositionals(args, 2, 2, this.usage);
    const id = positional(args, 0, 'instance');
    const ms = positional(args, 1, 'ms');
    if (!/^[0-9]+$/.test(ms) || Number(ms) < 1) throw new OgwError(`invalid ms: ${ms}`);
    const count = nonNegativeInt(args, 'count') ?? 1;
    if (count < 1) throw new OgwError(`invalid --count: ${String(count)}`);
    const outcome = await runSteps(ctx, { id, ms, count, capture: flag(args, 'capture') });
    return { exitCode: outcome.failed ? 1 : 0, text: outcomeLines(count, outcome).join('\n'), data: outcome };
  },
};
