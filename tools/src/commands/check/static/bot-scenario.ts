import { isDeepStrictEqual } from 'node:util';
import { absence, at, finding, folderOf, type Finding, type StaticContext } from './lib/context.ts';
import { cellOf } from './lib/csv.ts';
import { isSnakeCase } from './lib/files.ts';
import { isRecord, JsonPosError, parseJsonWithLines } from './lib/json-pos.ts';
import { NO_GOAL, scenarioProblems, SOCIAL_MODULES, STEP_KINDS, stepProblems as stepFormProblems, type FormProblem } from '../lib/scenario-form.ts';
import { qaBuiltins, type BuiltinKind } from './lib/specs.ts';

/**
 * bot scenario (`client-content` `## bot playtest`): `client/dev/bot/scenario.json` is missing or malformed, a required
 * step or `goal` is missing, or a `client/dev/bot/fixtures/` file is malformed.
 */
export const NAME = 'bot scenario';

export const SCENARIO = 'client/dev/bot/scenario.json';
const FIXTURES = 'client/dev/bot/fixtures/';

export interface Step {
  kind?: unknown;
  command?: unknown;
  args?: unknown;
  until?: unknown;
  timeoutMs?: unknown;
  social?: unknown;
}

/** The built-in or content command problem of a step whose form is valid, or null. */
function commandProblem(step: Step, builtins: Map<string, BuiltinKind>): string | null {
  const command = step.command;
  if (step.kind === 'save' || typeof command !== 'string') return null;
  if (step.kind === 'input') return builtins.get(command) === 'input' ? null : `\`${command}\` is not an input built-in command`;
  if (step.kind === 'auto') return /^[a-z][a-z0-9_]*\.bot_next_input$/.test(command) && isSnakeCase(command.split('.')[0] ?? '') ? null : '`auto` command must be `<feature>.bot_next_input`';
  const parts = command.split('.');
  const content = parts.length === 2 && parts.every(isSnakeCase);
  return builtins.get(command) === 'setup' || content ? null : `\`${command}\` is not a setup built-in command or a content command`;
}

/** The command problem of a step at `pointer`, as a list of at most one problem. */
function commandProblems(step: unknown, pointer: string, builtins: Map<string, BuiltinKind>): FormProblem[] {
  if (!isRecord(step) || typeof step.kind !== 'string' || !STEP_KINDS.has(step.kind)) return [];
  const command = commandProblem(step, builtins);
  return command === null ? [] : [[pointer, command]];
}

/** Problems of one step: its form (`scenario-form.ts`) and its command against the `QACore` built-in commands. */
export function stepProblems(step: unknown, pointer: string, builtins: Map<string, BuiltinKind>): FormProblem[] {
  return [...stepFormProblems(step, pointer), ...commandProblems(step, pointer, builtins)];
}

function containsGoal(cond: unknown): boolean {
  if (!isRecord(cond)) return false;
  if (Array.isArray(cond.all)) return cond.all.some(containsGoal);
  return cond.path === 'telemetry.goal_intervals' && cond.op === 'count_gte' && typeof cond.value === 'number' && Number.isInteger(cond.value) && cond.value >= 1;
}

function untilIs(step: Step | undefined, cond: object): boolean {
  return step !== undefined && isDeepStrictEqual(step.until, cond);
}

function isCommand(step: Step, command: string, args: string[] | null): boolean {
  return step.command === command && (args === null || isDeepStrictEqual(step.args ?? [], args));
}

/** First index at or after `from` of a step matching `test`, or -1. */
function findFrom(steps: readonly Step[], from: number, test: (s: Step) => boolean): number {
  for (let i = Math.max(0, from); i < steps.length; i++) if (test(steps[i] as Step)) return i;
  return -1;
}

/** `<command> step, then a later step with until`. */
function followedByUntil(steps: readonly Step[], command: string, args: string[] | null): boolean {
  for (let i = 0; i < steps.length; i++) {
    if (isCommand(steps[i] as Step, command, args) && findFrom(steps, i + 1, (s) => s.until !== undefined) !== -1) return true;
  }
  return false;
}

export interface Requirements {
  /** ID name of the `tutorial` row with the smallest `order`, or null without tutorial rows. */
  firstTutorial: string | null;
  realtime: boolean;
  allowRoom: boolean;
  social: string[];
}

function tutorialMissing(steps: readonly Step[], n: string): boolean {
  for (let i = 0; i < steps.length; i++) {
    if (!untilIs(steps[i], { path: 'state.tutorial.id', op: 'eq', value: n })) continue;
    if (steps[i + 1]?.kind !== 'save') continue;
    if (findFrom(steps, i + 2, (s) => untilIs(s, { path: `state.completed_tutorials.${n}`, op: 'eq', value: true })) !== -1) return false;
  }
  return true;
}

function reconnectMissing(steps: readonly Step[]): boolean {
  const failed = findFrom(steps, 0, (s) => isCommand(s, 'force_network_failure', ['connection_failed']));
  const restored = failed === -1 ? -1 : findFrom(steps, failed + 1, (s) => isCommand(s, 'force_network_failure', ['none']));
  return restored === -1 || findFrom(steps, restored + 1, (s) => s.until !== undefined) === -1;
}

const PLAYING = { path: 'state.match_state', op: 'eq', value: 'Playing' };

function roomMissing(steps: readonly Step[]): boolean {
  const room = findFrom(steps, 0, (s) => untilIs(s, { path: 'state.room_code', op: 'ne', value: '' }));
  return room === -1 || findFrom(steps, room + 1, (s) => untilIs(s, PLAYING)) === -1;
}

/** Required steps that the scenario lacks, as messages. */
export function missingSteps(steps: readonly Step[], req: Requirements): string[] {
  const out: string[] = [];
  if (!steps.some((s) => s.kind === 'save')) out.push('no `save` step');
  if (req.firstTutorial !== null && tutorialMissing(steps, req.firstTutorial)) out.push(`no tutorial resume steps for \`${req.firstTutorial}\``);
  if (reconnectMissing(steps)) out.push('no reconnect steps (`force_network_failure` `connection_failed`, then `none`, then a step with `until`)');
  if (req.realtime) {
    if (!followedByUntil(steps, 'drop_peer', ['other'])) out.push('no `drop_peer` `other` step followed by a step with `until`');
    if (!followedByUntil(steps, 'drop_matchmaker', null)) out.push('no `drop_matchmaker` step followed by a step with `until`');
    if (!steps.some((s) => s.kind === 'setup' && s.command === 'restart' && untilIs(s, PLAYING))) out.push('no `setup` `restart` step with `until` match state `Playing`');
    if (req.allowRoom && roomMissing(steps)) out.push('no room steps (`until` room code not empty, then `until` match state `Playing`)');
  }
  for (const m of req.social) {
    if (!steps.some((s) => s.social === m && s.until !== undefined)) out.push(`no step with \`social\` \`${m}\` and \`until\``);
  }
  return out;
}

function parse(text: string, path: string): { value: unknown; lines: Map<string, number> } | Finding {
  try {
    return parseJsonWithLines(text);
  } catch (error) {
    return finding(NAME, at(path, error instanceof JsonPosError ? error.line : 1), 'not JSON');
  }
}

function toFindings(path: string, lines: Map<string, number>, problems: FormProblem[]): Finding[] {
  return problems.map(([pointer, message]) => finding(NAME, at(path, lines.get(pointer) ?? 1), message));
}

export function checkScenario(text: string, builtins: Map<string, BuiltinKind>, req: Requirements): Finding[] {
  const parsed = parse(text, SCENARIO);
  if ('where' in parsed) return [parsed];
  const { value, lines } = parsed;
  if (!isRecord(value)) return [finding(NAME, at(SCENARIO, 1), 'scenario is not a JSON object')];
  const form = scenarioProblems(value);
  const problems = form.filter(([, message]) => message !== NO_GOAL);
  const steps = Array.isArray(value.steps) ? (value.steps as unknown[]) : [];
  steps.forEach((s, i) => problems.push(...commandProblems(s, `/steps/${String(i)}`, builtins)));
  if (value.goal !== undefined && !containsGoal(value.goal)) {
    problems.push(['/goal', '`goal` has no `{"path": "telemetry.goal_intervals", "op": "count_gte", "value": <n>}` with n of 1 or more']);
  }
  const out = toFindings(SCENARIO, lines, problems);
  if (form.some(([, message]) => message === NO_GOAL)) out.push(absence(NAME, at(SCENARIO, 1), NO_GOAL));
  for (const message of missingSteps(steps.filter(isRecord), req)) out.push(absence(NAME, at(SCENARIO, 1), message));
  return out;
}

export function checkFixture(path: string, text: string, builtins: Map<string, BuiltinKind>): Finding[] {
  const name = path.slice(FIXTURES.length).replace(/\.json$/, '');
  if (!path.endsWith('.json') || !isSnakeCase(name)) return [finding(NAME, at(path, 1), 'save fixture file name must be `<snake_case name>.json`')];
  const parsed = parse(text, path);
  if ('where' in parsed) return [parsed];
  const { value, lines } = parsed;
  if (!isRecord(value) || Object.keys(value).join(',') !== 'steps' || !Array.isArray(value.steps)) return [finding(NAME, at(path, 1), 'save fixture must be `{"steps": [<step>, ...]}`')];
  const problems: FormProblem[] = [];
  value.steps.forEach((s: unknown, i: number) => {
    const pointer = `/steps/${String(i)}`;
    problems.push(...stepProblems(s, pointer, builtins));
    if (isRecord(s) && s.kind !== 'setup') problems.push([pointer, 'save fixture step `kind` must be `setup`']);
  });
  return toFindings(path, lines, problems);
}

async function requirements(sc: StaticContext): Promise<Requirements> {
  const modules = await sc.modules();
  const tutorial = await sc.table('data/tables/tutorial.csv');
  let firstTutorial: string | null = null;
  let best = Infinity;
  for (const row of tutorial?.rows ?? []) {
    const order = Number(tutorial ? cellOf(tutorial, row, 'order') : NaN);
    if (Number.isFinite(order) && order < best) {
      best = order;
      firstTutorial = row.cells[0] ?? null;
    }
  }
  const matchMode = await sc.table('data/tables/match_mode.csv');
  const allowRoom = (matchMode?.rows ?? []).some((row) => matchMode !== null && cellOf(matchMode, row, 'allow_room') === 'true');
  return {
    firstTutorial,
    realtime: modules.client.includes('RealtimeCore'),
    allowRoom,
    social: SOCIAL_MODULES.filter((m) => modules.server.includes(m)),
  };
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const builtins = await qaBuiltins(sc);
  const out: Finding[] = [];
  if (!sc.has(SCENARIO)) out.push(absence(NAME, folderOf(SCENARIO), 'scenario file is missing'));
  else out.push(...checkScenario(await sc.text(SCENARIO), builtins, await requirements(sc)));
  for (const path of sc.filter((p) => p.startsWith(FIXTURES) && !/\.(import|uid)$/.test(p))) {
    out.push(...checkFixture(path, await sc.text(path), builtins));
  }
  return out;
}
