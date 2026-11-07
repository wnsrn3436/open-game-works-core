import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CheckResult } from '../../check/api.ts';
import { readScenario } from '../../check/lib/bot-playtest.ts';
import { checkResult, failure } from '../../check/lib/evidence.ts';
import { Slots } from '../../check/lib/instances.ts';
import type { Scenario } from '../../check/lib/scenario.ts';
import type { BuildCheck } from './buildrun.ts';
import { buildCheckOf, didNotRun, evidenceOf, launchValuesOf, withCheckInstance, withCheckWorkspace, type CheckExporter, type ClientCheckInput } from './client-check.ts';
import { outcome } from './settingschecks.ts';
import { webRunSettings, webScenario, withWebPage, type WebRun } from './web-smoke.ts';

const NAME = 'repeat test';

/**
 * The number of runs (ogw.md `### repeat test`): with no failed run in 36, fewer than 8% of runs fail at 95% confidence
 * (0.92^36 < 0.05). A fixed value of the check; a test makes it small.
 */
export const repeatPlan = { runs: 36 };

/** The kinds of a failed run, in the order of ogw.md `### repeat test` 3. */
export const RUN_KINDS = ['crash', 'softlock', 'error log', 'failed goal', 'other'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** The outcome of one run: its result, the kind when it failed, and its first line. */
export interface RepeatRun {
  result: 'pass' | 'fail' | 'unknown';
  kind: RunKind | null;
  line: string;
}

/** The kind of a no blocker failure message (ogw.md `### repeat test` 3), `failed goal` aside. */
export function blockerKind(message: string): RunKind {
  if (/^client process \S+ ended|^server process ended/.test(message)) return 'crash';
  if (/^softlock |^step did not end within |did not reach boot_stage Done within /.test(message)) return 'softlock';
  if (/^client \S+ error log: |^server error log: /.test(message)) return 'error log';
  return 'other';
}

/** One run from its no blocker and full flow results. */
export function runOf(env: ClientCheckInput['env'], results: readonly [CheckResult, CheckResult]): RepeatRun {
  const [noBlocker, fullFlow] = results;
  const line = buildCheckOf('web smoke', env, results).details[0] ?? '';
  if (noBlocker.result === 'fail') return { result: 'fail', kind: blockerKind(noBlocker.failures[0]?.message ?? ''), line };
  if (fullFlow.result === 'fail') return { result: 'fail', kind: 'failed goal', line };
  if (noBlocker.result === 'unknown' || fullFlow.result === 'unknown') return { result: 'unknown', kind: null, line };
  return { result: 'pass', kind: null, line: '' };
}

/** The check from its runs (ogw.md `### repeat test` 4). */
export function repeatVerdict(env: ClientCheckInput['env'], runs: readonly RepeatRun[]): BuildCheck {
  const failed = runs.filter((r) => r.result === 'fail');
  const counts = RUN_KINDS.map((kind) => `${kind} ${String(failed.filter((r) => r.kind === kind).length)}`).join(', ');
  const lines = runs.flatMap((r, i) => (r.result === 'pass' ? [] : [`run ${String(i + 1)}: ${r.line}`]));
  const details = [`${String(failed.length)} of ${String(runs.length)} runs failed: ${counts}`, ...lines];
  if (failed.length > 0) return { name: NAME, result: outcome(NAME, env, details), details };
  if (lines.length > 0) return { name: NAME, result: 'unknown', details };
  return { name: NAME, result: 'pass', details: [] };
}

/** One run: its own check instance, check export and page (ogw.md `### repeat test` 1); the logs of a run that passed are not kept. */
async function oneRun(input: ClientCheckInput, scenario: Scenario, run: WebRun, exportFor: CheckExporter, n: number): Promise<RepeatRun> {
  const { ctx } = input;
  const evidence = evidenceOf(input, `repeat-test/run-${String(n)}`);
  try {
    const repeat = await withCheckInstance(ctx, input.game, 'web', async (instance, external) => {
      const file = await exportFor('web', launchValuesOf(instance, external, 'web'), `web-run-${String(n)}`);
      try {
        return await withWebPage(ctx, run, file, async (page) => runOf(input.env, (await webScenario(input, instance, page, scenario, run.bootLimitMs, evidence)).results));
      } finally {
        await rm(dirname(file), { recursive: true, force: true });
      }
    });
    if (repeat.result === 'pass') await rm(join(evidence.root, evidence.dir ?? ''), { recursive: true, force: true });
    return repeat;
  } catch (error) {
    // a run that could not run to the end is `unknown`; an undefined step still stops the build run (`didNotRun`)
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('not defined:')) throw error;
    return { result: 'unknown', kind: null, line: `did not run: ${message}` };
  }
}

/**
 * Check `repeat test` (`build` `## build-time check`, ogw.md `### repeat test`): the bot playtest scenario in
 * `repeatPlan.runs` runs, each as a new user on its own DEV web export, at most `maxConcurrentInstances` at a time. Null
 * when the build has no web platform or is a PROD build.
 */
export async function repeatTest(input: ClientCheckInput): Promise<BuildCheck | null> {
  if (!input.platforms.includes('web') || input.env === 'PROD') return null;
  const { ctx } = input;
  const scenario = await readScenario(input.game.root);
  if (typeof scenario === 'string') {
    const where = failure('client/dev/bot/scenario.json:1', scenario);
    return buildCheckOf(NAME, input.env, [checkResult('no blocker', null, [where]), checkResult('full flow', null, [where])]);
  }
  try {
    const run = await webRunSettings(ctx);
    if (typeof run === 'string') return didNotRun(NAME, run);
    const max = (await ctx.settings()).maxConcurrentInstances;
    if (max === null) return didNotRun(NAME, 'harness settings maxConcurrentInstances is null');
    const slots = new Slots(max);
    return await withCheckWorkspace(input, async (exportFor) => {
      const runs = Array.from({ length: repeatPlan.runs }, async (_, i) => {
        await slots.acquire();
        try {
          return await oneRun(input, scenario, run, exportFor, i + 1);
        } finally {
          slots.release();
        }
      });
      return repeatVerdict(input.env, await Promise.all(runs));
    });
  } catch (error) {
    return didNotRun(NAME, error);
  }
}
