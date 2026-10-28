import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { isNotFound } from '../../../lib/fsx.ts';
import type { CheckResult } from '../api.ts';
import { checkResult, failure, writeEvidence, type Evidence } from './evidence.ts';
import { instanceServerLog } from './instance-probe.ts';
import { withInstance, type Slots } from './instances.ts';
import { clientLog } from './logs.ts';
import { parseScenario, runScenario, type Scenario, type ScenarioOutcome } from './scenario.ts';

/** Polling interval of instance state while a bot playtest scenario runs (`ogw check`, the shared-telemetry bot runs of `ogw loop evaluate`). */
export const BOT_PLAYTEST_POLL_MS = 200;

export const SCENARIO = 'client/dev/bot/scenario.json';

/**
 * `where` (`game-loop` `## loop iteration record`: a file:line) of a failure of a check that runs the scenario and
 * has no step or scene to point at: line 1 of the scenario file.
 */
export const SCENARIO_WHERE = `${SCENARIO}:1`;

/** Reads and parses the scenario of the checkout; an English reason when it is missing, unreadable or has another form. */
export async function readScenario(root: string): Promise<Scenario | string> {
  let text: string;
  try {
    text = await readFile(join(root, SCENARIO), 'utf8');
  } catch (error) {
    if (isNotFound(error)) return `${SCENARIO} does not exist`;
    return `${SCENARIO} could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  return parseScenario(text);
}

export interface InstanceCheckOptions {
  evidence: Evidence;
  slots: Slots;
  db?: 'postgresql';
  pollMs: number;
}

function bothUnknown(where: string, message: string, evidence: (string | null)[] = []): [CheckResult, CheckResult] {
  return [
    checkResult('no blocker', null, [failure(where, message, evidence)], true),
    checkResult('full flow', null, [failure(where, message, evidence)], true),
  ];
}

async function keepLogs(ctx: Context, id: string, evidence: Evidence, prefix: string): Promise<(string | null)[]> {
  const client = await clientLog(ctx, id, 'main').catch(() => null);
  const server = await instanceServerLog(ctx, id).catch(() => null);
  return [
    client === null ? null : await writeEvidence(evidence, `${prefix}/client.log`, client),
    server === null ? null : await writeEvidence(evidence, `${prefix}/server.log`, server),
  ];
}

/**
 * no blocker and full flow from a scenario outcome (`client-content` `## bot playtest`). A stop that is not a blocker
 * is a reason the bot playtest could not run on: both are `unknown`.
 */
export function judge(outcome: ScenarioOutcome, steps: number, logs: (string | null)[]): [CheckResult, CheckResult] {
  const { stop } = outcome;
  if (stop === null) {
    const flow = outcome.goal ? [] : [failure(`step ${String(steps)}`, 'goal is not true after the last step', logs)];
    return [checkResult('no blocker', null, []), checkResult('full flow', null, flow)];
  }
  const where = `step ${String(stop.step)}`;
  if (stop.failedStep === true) {
    const flow = checkResult('full flow', null, [failure(where, stop.message, logs)]);
    // a failed step stops the scenario before its blocker check and the steps after it: their blockers are not known
    return [checkResult('no blocker', null, [failure(where, `blockers of step ${String(stop.step)} and after were not checked: ${stop.message}`, logs)], true), flow];
  }
  if (!stop.blocker) return bothUnknown(where, stop.message, logs);
  const noBlocker = checkResult('no blocker', null, [failure(where, stop.message, logs)]);
  return [noBlocker, checkResult('full flow', null, [failure(where, `scenario stopped at step ${String(stop.step)}`, logs)])];
}

/**
 * no blocker and full flow: the bot playtest of `client/dev/bot/scenario.json` in a headless instance. `scenario` is
 * the `readScenario` result of the checkout.
 */
export async function botPlaytest(ctx: Context, game: string, scenario: Scenario | string, options: InstanceCheckOptions): Promise<[CheckResult, CheckResult]> {
  if (typeof scenario === 'string') {
    return [
      checkResult('no blocker', null, [failure(SCENARIO_WHERE, scenario)]),
      checkResult('full flow', null, [failure(SCENARIO_WHERE, scenario)]),
    ];
  }
  try {
    return await withInstance(ctx, options.slots, { game, client: 'headless', db: options.db }, async (instance) => {
      const outcome = await runScenario(ctx, instance.id, scenario, { pollMs: options.pollMs });
      const logs = await keepLogs(ctx, instance.id, options.evidence, 'bot-playtest');
      return judge(outcome, scenario.steps.length, logs);
    }, options.evidence);
  } catch (error) {
    return bothUnknown(SCENARIO_WHERE, `bot playtest did not run: ${(error as Error).message}`);
  }
}
