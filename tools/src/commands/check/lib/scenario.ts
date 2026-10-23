import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Context } from '../../../lib/command.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { automationRequest, restartClient, type AutomationResponse, type ClientRef } from '../../instance/automation.ts';
import { evaluate, jsonEqual, needsTelemetry, type Condition } from './condition.ts';
import { instanceProcesses, instanceServerLog } from './instance-probe.ts';
import { ClientLogUnreadable, clientErrorLines, clientLogFiles, serverErrorLines } from './logs.ts';
import { isRecord, pointerText, scenarioProblems } from './scenario-form.ts';
import { readRecord } from '../../instance/lib/records.ts';

/** Bot playtest scenario (`client-content` `## bot playtest`). */
export interface Step {
  kind: 'input' | 'setup' | 'auto' | 'save';
  command: string | null;
  args: string[];
  until: Condition | null;
  timeoutMs: number;
}

export interface Scenario {
  steps: Step[];
  goal: Condition;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** A step of a scenario that has the form `scenarioProblems` checks. */
function toStep(value: Record<string, unknown>): Step {
  const kind = value.kind as Step['kind'];
  return {
    kind,
    command: kind === 'save' ? null : (value.command as string),
    args: (value.args as string[] | undefined) ?? [],
    until: (value.until as Condition | undefined) ?? null,
    timeoutMs: value.timeoutMs as number,
  };
}

/**
 * Parses `client/dev/bot/scenario.json`. Returns an English reason when the file does not have the defined form
 * (`scenario-form.ts`, the rules static check `bot scenario` uses too).
 */
export function parseScenario(text: string): Scenario | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return `scenario is not JSON: ${(error as Error).message}`;
  }
  const problem = scenarioProblems(value)[0];
  if (problem !== undefined) return `${pointerText(problem[0])}: ${problem[1]}`;
  const scenario = value as { steps: Record<string, unknown>[]; goal: Condition };
  return { steps: scenario.steps.map(toStep), goal: scenario.goal };
}

export interface ScenarioOptions {
  /** Interval of `get_state` polling while a condition is not true yet. */
  pollMs: number;
  /** Called after each step that ended without a blocker, with the 1-based step number. */
  afterStep?: (n: number) => Promise<void>;
  /**
   * A blocker of a client the runner did not start (a device or browser client of the build-time checks),
   * checked with the process blocker; null when there is none.
   */
  blocker?: () => Promise<string | null>;
}

/** Where (step number) and what stopped the scenario. */
export interface ScenarioStop {
  step: number;
  message: string;
  /**
   * True when it is one of the `no blocker` `fail` conditions (`client-content` `## bot playtest`); false when the
   * step could not go on for another reason, which leaves no blocker and full flow `unknown`.
   */
  blocker: boolean;
  /**
   * A failed step (`client-content` `## bot playtest`, the `save` step): full flow `fail`, and no blocker `unknown` for
   * the blockers of that step and after.
   */
  failedStep?: boolean;
}

export interface ScenarioOutcome {
  stop: ScenarioStop | null;
  /** The `goal` condition after the last step; false when the scenario stopped. */
  goal: boolean;
}

class Stop extends Error {
  readonly stop: ScenarioStop;
  constructor(stop: ScenarioStop) {
    super(stop.message);
    this.stop = stop;
  }
}

const TIMEOUT: unique symbol = Symbol('timeout');

async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | typeof TIMEOUT> {
  const left = deadline - Date.now();
  if (left <= 0) return TIMEOUT;
  const controller = new AbortController();
  const timer = sleep(left, undefined, { signal: controller.signal }).then(
    (): typeof TIMEOUT => TIMEOUT,
    (): typeof TIMEOUT => TIMEOUT,
  );
  try {
    return await Promise.race([promise, timer]);
  } finally {
    controller.abort();
  }
}

/** A blocker read from a `QAState` object, or null. */
export function stateBlocker(state: Record<string, unknown>): string | null {
  if (state.boot_stage === 'Halted') return 'boot_stage is Halted';
  if (Array.isArray(state.invariant_failures) && state.invariant_failures.length > 0) {
    return `invariant failures: ${state.invariant_failures.map(String).join(', ')}`;
  }
  if (state.softlock !== null && state.softlock !== undefined) return `softlock ${JSON.stringify(state.softlock)}`;
  return null;
}

/**
 * How far `processBlocker` already looked at the logs: per client and per log file path of `extract_logs` the byte length
 * of that file's content up to the last line break, and the server log bytes up to the last line break. A later call
 * looks only at what comes after. A log file path the cursor does not hold (a new file after rotation or a new boot)
 * is read from its start, and a file that got shorter than its offset is read again from its start.
 */
export class LogCursor {
  readonly clients = new Map<string, Map<string, number>>();
  server = 0;
}

/** Bytes up to and including the last line break of `text`, or 0. */
function checkedBytes(text: string): number {
  return Buffer.byteLength(text.slice(0, text.lastIndexOf('\n') + 1));
}

/** The first `error` line in the client's log files after the cursor, moving the cursor past the checked lines. */
async function clientLogError(ctx: Context, id: string, client: ClientRef, cursor: LogCursor): Promise<string | undefined> {
  const seen = cursor.clients.get(client) ?? new Map<string, number>();
  const files = await clientLogFiles(ctx, id, client, seen);
  const next = new Map<string, number>();
  for (const { path, offset, content } of files) {
    // a client that gave the whole file: the part after the cursor is cut here
    const whole = Buffer.from(content);
    const from = seen.get(path) ?? 0;
    const start = offset ?? (whole.length < from ? 0 : from);
    const fresh = offset === null ? whole.subarray(start).toString() : content;
    const line = clientErrorLines(fresh)[0];
    if (line !== undefined) return line;
    next.set(path, start + checkedBytes(fresh));
  }
  cursor.clients.set(client, next);
  return undefined;
}

/**
 * A blocker from the processes and logs of the instance, or null. With a cursor, only log lines after it are read.
 * Throws `ClientLogUnreadable` when a client log or the server log could not be read.
 */
export async function processBlocker(ctx: Context, id: string, cursor: LogCursor = new LogCursor()): Promise<string | null> {
  const processes = await instanceProcesses(ctx, id);
  if (!processes.server) return 'server process ended';
  const ended = processes.clients.find((client) => !client.alive);
  if (ended) return `client process ${ended.client} ended`;
  for (const { client } of processes.clients) {
    const line = await clientLogError(ctx, id, client, cursor);
    if (line !== undefined) return `client ${client} error log: ${line}`;
  }
  const server = await instanceServerLog(ctx, id, cursor.server).catch((error: unknown) => {
    throw new ClientLogUnreadable(`the server log could not be read: ${(error as Error).message}`);
  });
  const lines = serverErrorLines(server);
  if (lines[0] !== undefined) return `server error log: ${lines[0]}`;
  cursor.server += checkedBytes(server);
  return null;
}

class ScenarioRun {
  private readonly ctx: Context;
  private readonly id: string;
  private readonly options: ScenarioOptions;
  private readonly logs = new LogCursor();
  private step = 0;
  private timeoutMs = 0;
  private deadline = 0;
  private readonly inputGapMs: number;
  private lastInputAt = 0;

  constructor(ctx: Context, id: string, options: ScenarioOptions, inputGapMs: number) {
    this.ctx = ctx;
    this.id = id;
    this.options = options;
    this.inputGapMs = inputGapMs;
  }

  private fail(message: string, blocker = true, failedStep = false): never {
    throw new Stop({ step: this.step, message, blocker, ...(failedStep ? { failedStep } : {}) });
  }

  private async request(command: string, args: string[]): Promise<AutomationResponse> {
    let response: AutomationResponse | typeof TIMEOUT;
    try {
      response = await beforeDeadline(automationRequest(this.ctx, this.id, command, args), this.deadline);
    } catch (error) {
      const blocker = await this.blockerOfStop();
      return blocker === null ? this.fail(`${command} failed: ${(error as Error).message}`, false) : this.fail(blocker);
    }
    if (response === TIMEOUT) return this.fail(`step did not end within ${String(this.timeoutMs)} ms`);
    if (!response.ok) this.fail(`${command} returned ok false: ${JSON.stringify(response.result)}`);
    return response;
  }

  /** `get_state` (and `get_telemetry` when asked); fails on a blocker in the state. */
  private async read(telemetry: boolean): Promise<{ state: unknown; telemetry: unknown }> {
    const state = (await this.request('get_state', [])).result;
    if (!isRecord(state)) this.fail('get_state returned no QAState', false);
    const blocker = stateBlocker(state);
    if (blocker !== null) this.fail(blocker);
    return { state, telemetry: telemetry ? (await this.request('get_telemetry', [])).result : null };
  }

  private async waitUntil(condition: Condition): Promise<void> {
    const telemetry = needsTelemetry(condition);
    for (;;) {
      if (evaluate(condition, await this.read(telemetry))) return;
      await sleep(this.options.pollMs);
    }
  }

  /**
   * Sends a command that restarts the client through the runner (`restartClient`), which waits for the new automation
   * channel connection and then for `boot_stage` `Done`.
   */
  private async restart(command: 'restart' | 'set_language', args: string[]): Promise<void> {
    const timeoutMs = Math.max(1, this.deadline - Date.now());
    let done: Record<string, unknown> | typeof TIMEOUT;
    try {
      done = await beforeDeadline(restartClient(this.ctx, this.id, 'main', { command, args, timeoutMs }), this.deadline);
    } catch (error) {
      if (Date.now() >= this.deadline) done = TIMEOUT;
      else {
        const blocker = await this.blockerOfStop();
        return blocker === null ? this.fail((error as Error).message, false) : this.fail(blocker);
      }
    }
    if (done === TIMEOUT) this.fail(`step did not end within ${String(this.timeoutMs)} ms: boot_stage is not Done`);
  }

  private async command(step: Step): Promise<void> {
    const command = step.command ?? '';
    if (command === 'restart' || command === 'set_language') await this.restart(command, step.args);
    else await this.request(command, step.args);
  }

  private async auto(step: Step): Promise<void> {
    const until = step.until as Condition;
    const telemetry = needsTelemetry(until);
    for (;;) {
      // the gap goes before the bot picks: the input it picks goes in at once, on the state it was picked from
      const wait = this.lastInputAt + this.inputGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      const { result } = await this.request(step.command ?? '', step.args);
      if (result !== null) {
        if (!isRecord(result) || typeof result.command !== 'string' || !isStringList(result.args)) {
          this.fail(`${step.command ?? ''} returned no input command: ${JSON.stringify(result)}`, false);
        }
        await this.request(result.command, result.args);
        this.lastInputAt = Date.now();
      }
      if (evaluate(until, await this.read(telemetry))) return;
    }
  }

  private async save(): Promise<void> {
    const before = await this.read(false);
    await this.restart('restart', []);
    const after = await this.read(false);
    const a = isRecord(before.state) ? before.state.content : null;
    const b = isRecord(after.state) ? after.state.content : null;
    if (!jsonEqual(a, b)) this.fail(`save: content differs after restart: ${JSON.stringify(a)} then ${JSON.stringify(b)}`, false, true);
  }

  private begin(n: number, timeoutMs: number): void {
    this.step = n;
    this.timeoutMs = timeoutMs;
    this.deadline = Date.now() + timeoutMs;
  }

  async runStep(step: Step, n: number): Promise<void> {
    this.begin(n, step.timeoutMs);
    if (step.kind === 'save') await this.save();
    else if (step.kind === 'auto') await this.auto(step);
    else await this.command(step);
    if (step.kind !== 'auto' && step.until !== null) await this.waitUntil(step.until);
    else await this.read(false);
    const blocker = await this.blocker();
    if (blocker !== null) this.fail(blocker);
  }

  /** A blocker of the processes, logs or `options.blocker`, or null; an unreadable client log stops the run as no blocker. */
  private async blocker(): Promise<string | null> {
    try {
      const found = await processBlocker(this.ctx, this.id, this.logs);
      return found ?? (this.options.blocker ? await this.options.blocker() : null);
    } catch (error) {
      if (error instanceof ClientLogUnreadable) return this.fail(error.message, false);
      throw error;
    }
  }

  /**
   * {@link blocker} for a step that already stops on a failed request: an unreadable client log (a client that does
   * not answer) is no blocker, and the request's own error names the stop.
   */
  private async blockerOfStop(): Promise<string | null> {
    try {
      return await this.blocker();
    } catch (error) {
      if (error instanceof Stop && !error.stop.blocker) return null;
      throw error;
    }
  }

  async goal(condition: Condition, steps: number): Promise<boolean> {
    this.begin(steps, LIMITS.shortMs);
    return evaluate(condition, await this.read(true));
  }
}

/**
 * Runs the steps of a scenario on the client of an instance and stops at the first step that fails.
 * Blockers: `state.boot_stage` `Halted`, `state.invariant_failures`, `state.softlock`, a command with `ok` false,
 * a step past `timeoutMs`, an ended process, an error log line. Any other stop is not a blocker.
 */
/**
 * The gap between two inputs of an `auto` step: twice the game's merged core settings `UICore.buttonClickIntervalMs`,
 * so a click is not dropped when the frames that take two inputs come late and early; 0 when the game has no such key.
 */
export async function autoInputGapMs(ctx: Context, id: string): Promise<number> {
  const root = (await readRecord(id, ctx.env)).root;
  const text = await readFile(join(root, 'client', 'generated', 'core_settings.json'), 'utf8').catch(() => null);
  if (text === null) return 0;
  const value = (JSON.parse(text) as Record<string, unknown>)['UICore.buttonClickIntervalMs'];
  return typeof value === 'number' && value > 0 ? value * 2 : 0;
}

export async function runScenario(ctx: Context, id: string, scenario: Scenario, options: ScenarioOptions): Promise<ScenarioOutcome> {
  const run = new ScenarioRun(ctx, id, options, await autoInputGapMs(ctx, id).catch(() => 0));
  try {
    for (const [i, step] of scenario.steps.entries()) {
      await run.runStep(step, i + 1);
      if (options.afterStep) await options.afterStep(i + 1);
    }
    return { stop: null, goal: await run.goal(scenario.goal, scenario.steps.length) };
  } catch (error) {
    if (error instanceof Stop) return { stop: error.stop, goal: false };
    throw error;
  }
}
