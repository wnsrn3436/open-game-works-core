import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { ignoreCleanupError } from '../../../lib/errors.ts';
import { writePageLaunchValues } from '../../../lib/godot-web.ts';
import { newSecretFolder } from '../../../lib/secret-files.ts';
import type { CheckResult } from '../../check/api.ts';
import { judge, readScenario } from '../../check/lib/bot-playtest.ts';
import { checkResult, failure, writeEvidence, type Evidence } from '../../check/lib/evidence.ts';
import { instanceServerLog } from '../../check/lib/instance-probe.ts';
import { clientErrorLines } from '../../check/lib/logs.ts';
import { runScenario, type Scenario } from '../../check/lib/scenario.ts';
import { toolProgram } from '../../env/api.ts';
import type { InstanceInfo } from '../../instance/api.ts';
import type { BuildCheck } from './buildrun.ts';
import { openHeadless, type HeadlessPage } from './chromium.ts';
import {
  atGate,
  buildCheckOf,
  checkoutOf,
  clientCheckTiming,
  didNotRun,
  ranToEnd,
  evidenceOf,
  NO_GATE,
  serveFolder,
  waitClientBoot,
  withCheckInstance,
  withWebCopy,
  type ClientCheckInput,
  type MeasureGate,
} from './client-check.ts';
import type { LaunchValues } from './godot.ts';

const NAME = 'web smoke';

export interface WebSmokeResult {
  check: BuildCheck;
  /** ms from opening the page until `boot_stage` `Done`, or null when it was not reached. */
  loadingMs: number | null;
}

/** Blocker of the browser client: the page is gone, or an error level line in the browser console (the client output). */
export function pageBlocker(page: HeadlessPage): () => Promise<string | null> {
  return () => {
    const ended = page.ended();
    if (ended !== null) return Promise.resolve(`client process main ended: ${ended}`);
    const line = clientErrorLines(page.console.join('\n'))[0];
    return Promise.resolve(line === undefined ? null : `client main error log: ${line}`);
  };
}

function both(where: string, message: string, unknown: boolean, evidence: (string | null)[] = []): [CheckResult, CheckResult] {
  return [checkResult('no blocker', null, [failure(where, message, evidence)], unknown), checkResult('full flow', null, [failure(where, message, evidence)], unknown)];
}

/**
 * `### web smoke` 4 on an open page: waits for `boot_stage` `Done`, runs the scenario and judges no blocker and full flow;
 * the browser console and the server log go into `evidence`.
 */
export async function webScenario(
  input: ClientCheckInput,
  instance: InstanceInfo,
  page: HeadlessPage,
  scenario: Scenario,
  bootLimitMs: number,
  evidence: Evidence,
): Promise<{ results: [CheckResult, CheckResult]; loadingMs: number | null }> {
  const { ctx } = input;
  const blocker = pageBlocker(page);
  const logs = async (): Promise<(string | null)[]> => [
    await writeEvidence(evidence, 'console.log', `${page.console.join('\n')}\n`),
    // evidence only: a server log that cannot be read says so in the file instead of reading as an empty log
    await writeEvidence(evidence, 'server.log', await instanceServerLog(ctx, instance.id).catch((error: unknown) => `the server log could not be read: ${(error as Error).message}\n`)),
  ];
  const boot = await waitClientBoot(ctx, instance.id, blocker, bootLimitMs);
  if (boot.kind !== 'done') {
    const files = await logs();
    const noBlocker = checkResult('no blocker', null, [failure('boot', boot.message, files)]);
    return { results: [noBlocker, checkResult('full flow', null, [failure('boot', 'the scenario did not start', files)])], loadingMs: null };
  }
  const outcome = await runScenario(ctx, instance.id, scenario, { pollMs: clientCheckTiming.pollMs, blocker });
  return { results: judge(outcome, scenario.steps.length, await logs()), loadingMs: boot.at - page.openedAt };
}

/** The harness settings of `### web smoke` 3 and 4, or the reason the browser cannot run. */
export interface WebRun {
  chromium: string;
  rate: number;
  bootLimitMs: number;
}

export async function webRunSettings(ctx: Context): Promise<WebRun | string> {
  const chromium = await toolProgram(ctx, 'chromium');
  if (chromium === null) return 'harness settings tools.chromium is not on this host';
  const { webSmokeCpuThrottleRate: rate, webSmokeBootTimeoutMs: bootLimitMs } = await ctx.settings();
  if (rate === null) return 'harness settings webSmokeCpuThrottleRate has no value: update env has not measured it on this host';
  return { chromium, rate, bootLimitMs };
}

/** The switches of the headless browser of the web checks: the JavaScript heap that `get_stats` reads is the current one. */
export const WEB_CHECK_SWITCHES: readonly string[] = ['--enable-precise-memory-info'];

/**
 * `### web smoke` 3 and 5 around `use`: serves the folder of the web check export `file`, and on the same port `values`
 * (the launch values of the check instance of the page) as a launch value file under a path with a new random part,
 * opens its `index.html` with the CPU throttle and `ogw_launch_values` naming that file, then closes the page and the
 * server. The launch value file holds secret values (`OGW_DEV_ACCESS`), so it is written into a new secret folder,
 * deleted with it.
 */
export async function withWebPage<T>(ctx: Context, run: WebRun, file: string, values: LaunchValues, use: (page: HeadlessPage) => Promise<T>): Promise<T> {
  const folder = await newSecretFolder('ogw-page-launch-values-', ctx.env);
  try {
    const query = await writePageLaunchValues(folder, '/', values);
    const path = new URLSearchParams(query).get('ogw_launch_values') ?? '';
    const host = await serveFolder(dirname(file), { [path]: join(folder, basename(path)) });
    try {
      const page = await openHeadless(ctx, run.chromium, `${host.url}/index.html?${query}`, run.rate, WEB_CHECK_SWITCHES);
      try {
        return await use(page);
      } finally {
        await page.close();
      }
    } finally {
      await host.close();
    }
  } finally {
    // the folder of this page only: a leftover changes no result
    await rm(folder, { recursive: true, force: true }).catch(ignoreCleanupError);
  }
}

/**
 * Check `web smoke` (`build` `## build-time check`, ogw.md `### web smoke`). Null when the build has no web platform. Its
 * check instance and the web check export (made here when no web check made it yet) come first; the page opens when
 * `gate` lets it measure.
 */
export async function webSmoke(input: ClientCheckInput, gate: MeasureGate = NO_GATE): Promise<WebSmokeResult | null> {
  if (!input.platforms.includes('web')) return null;
  const { ctx } = input;
  const scenario = await readScenario(checkoutOf(input));
  if (typeof scenario === 'string') return { check: buildCheckOf(NAME, input.env, both('client/dev/bot/scenario.json:1', scenario, false)), loadingMs: null };
  try {
    const run = await webRunSettings(ctx);
    if (typeof run === 'string') return { check: didNotRun(NAME, run), loadingMs: null };
    return await withWebCopy(input, (own) =>
      withCheckInstance(ctx, input.game, 'web', async (instance, _external, values) => {
        const file = await own.workspaces.webExport();
        await atGate(gate);
        return withWebPage(ctx, run, file, values, async (page) => {
          const { results, loadingMs } = await webScenario(input, instance, page, scenario, run.bootLimitMs, evidenceOf(input, 'web-smoke'));
          return { check: ranToEnd(NAME, buildCheckOf(NAME, input.env, results)), loadingMs };
        });
      }),
    );
  } catch (error) {
    return { check: didNotRun(NAME, error), loadingMs: null };
  }
}
