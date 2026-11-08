import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import type { CheckResult } from '../../check/api.ts';
import { readScenario } from '../../check/lib/bot-playtest.ts';
import { checkResult, failure, writeEvidence } from '../../check/lib/evidence.ts';
import { Slots } from '../../check/lib/instances.ts';
import type { Scenario } from '../../check/lib/scenario.ts';
import { isRecord } from '../../check/lib/scenario-form.ts';
import { automationRequest } from '../../instance/automation.ts';
import type { BuildCheck } from './buildrun.ts';
import { buildCheckOf, byteCount, checkoutOf, didNotRun, evidenceOf, withCheckInstance, withWorkspacesOf, type CheckWorkspaces, type ClientCheckInput } from './client-check.ts';
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

/** The values of the `get_stats` a run reads when its scenario has ended (ogw.md `### repeat test` 1 and 4). */
export interface RunStats {
  heapMemoryBytes: number | null;
  totalMemoryBytes: number | null;
  maxFrameIntervalMs: number | null;
}

/** A run and its `get_stats` values; null for a run that read none. */
export interface RunOutcome {
  run: RepeatRun;
  stats: RunStats | null;
}

/** The values of one `get_stats` result; a value that is not of its type is null. */
export function runStats(result: unknown): RunStats {
  const stats = isRecord(result) ? result : {};
  const interval = stats.max_frame_interval_ms;
  return {
    heapMemoryBytes: byteCount(stats.heap_memory_bytes),
    totalMemoryBytes: byteCount(stats.total_memory_bytes),
    maxFrameIntervalMs: typeof interval === 'number' && Number.isFinite(interval) && interval >= 0 ? interval : null,
  };
}

/** One object of `runs.json` (ogw.md `### repeat test` 4): run `n`, whose check instance had random base `n`. */
export function runRecord(n: number, { run, stats }: RunOutcome): Record<string, unknown> {
  return { run: n, randomBase: n, result: run.result, kind: run.kind, heapMemoryBytes: stats?.heapMemoryBytes ?? null, totalMemoryBytes: stats?.totalMemoryBytes ?? null, maxFrameIntervalMs: stats?.maxFrameIntervalMs ?? null };
}

/** The `get_stats` of a run whose scenario has ended; null when it read none (the request failed or its answer is not `ok`). */
async function readStats(ctx: Context, id: string): Promise<RunStats | null> {
  try {
    const answer = await automationRequest(ctx, id, 'get_stats', []);
    return answer.ok ? runStats(answer.result) : null;
  } catch (error) {
    // a request that the instance did not answer is a run that read none; another error stops the run
    if (!(error instanceof OgwError)) throw error;
    return null;
  }
}

/**
 * Run `n` (ogw.md `### repeat test` 1): its own check instance with random base `n`, and `### web smoke` 2 to 4 on the
 * web check export with the launch values of that instance. The copy of the web check export comes before the instance
 * starts, and a run that would only read a failed export starts none. The logs of a run that passed are not kept.
 */
async function oneRun(input: ClientCheckInput & { workspaces: CheckWorkspaces }, scenario: Scenario, run: WebRun, n: number): Promise<RunOutcome> {
  const { ctx, workspaces } = input;
  const evidence = evidenceOf(input, `repeat-test/run-${String(n)}`);
  try {
    await workspaces.webCopy();
    const failed = workspaces.webExportFailure();
    if (failed !== null) throw failed.error;
    const repeat = await withCheckInstance(ctx, input.game, 'web', async (instance, _external, values) => {
      const file = await workspaces.webExport();
      return withWebPage(ctx, run, file, values, async (page) => {
        const { results, loadingMs } = await webScenario(input, instance, page, scenario, run.bootLimitMs, evidence);
        // a boot that did not reach Done ran no scenario
        return { run: runOf(input.env, results), stats: loadingMs === null ? null : await readStats(ctx, instance.id) };
      });
    }, checkoutOf(input), n);
    if (repeat.run.result === 'pass') await rm(join(evidence.root, evidence.dir ?? ''), { recursive: true, force: true });
    return repeat;
  } catch (error) {
    // a run that could not run to the end is `unknown`; an undefined step still stops the build run (`didNotRun`)
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('not defined:')) throw error;
    return { run: { result: 'unknown', kind: null, line: `did not run: ${message}` }, stats: null };
  }
}

/**
 * Check `repeat test` (`build` `## build-time check`, ogw.md `### repeat test`): the bot playtest scenario in
 * `repeatPlan.runs` runs, at most `maxConcurrentInstances` at a time, each as a new user on its own check instance
 * with its own random base and a page of the one web check export of the check workspaces, which starts here, beside the
 * check instances of the runs, when no web check made it yet. `runs.json` holds the runs. Null when the build has no web
 * platform or is a PROD build.
 */
export async function repeatTest(input: ClientCheckInput): Promise<BuildCheck | null> {
  if (!input.platforms.includes('web') || input.env === 'PROD') return null;
  const { ctx } = input;
  const scenario = await readScenario(checkoutOf(input));
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
    return await withWorkspacesOf(input, async (shared) => {
      shared.workspaces.startWebExport();
      const runs = Array.from({ length: repeatPlan.runs }, async (_, i) => {
        await slots.acquire();
        try {
          return await oneRun(shared, scenario, run, i + 1);
        } finally {
          slots.release();
        }
      });
      const outcomes = await Promise.all(runs);
      await writeEvidence(evidenceOf(input, 'repeat-test'), 'runs.json', `${JSON.stringify(outcomes.map((o, i) => runRecord(i + 1, o)), null, 2)}\n`);
      return repeatVerdict(input.env, outcomes.map((o) => o.run));
    });
  } catch (error) {
    return didNotRun(NAME, error);
  }
}
