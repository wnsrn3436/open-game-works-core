import { dirname } from 'node:path';
import type { CheckResult } from '../../check/api.ts';
import { judge, readScenario } from '../../check/lib/bot-playtest.ts';
import { checkResult, failure, writeEvidence } from '../../check/lib/evidence.ts';
import { instanceServerLog } from '../../check/lib/instance-probe.ts';
import { clientErrorLines } from '../../check/lib/logs.ts';
import { runScenario, type Scenario } from '../../check/lib/scenario.ts';
import { toolProgram } from '../../env/api.ts';
import type { InstanceInfo } from '../../instance/api.ts';
import type { BuildCheck } from './buildrun.ts';
import { openHeadless, type HeadlessPage } from './chromium.ts';
import {
  buildCheckOf,
  clientCheckTiming,
  didNotRun,
  ranToEnd,
  evidenceOf,
  launchValuesOf,
  serveFolder,
  waitClientBoot,
  withCheckExport,
  withCheckInstance,
  type ClientCheckInput,
} from './client-check.ts';

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

async function smoke(
  input: ClientCheckInput,
  instance: InstanceInfo,
  page: HeadlessPage,
  scenario: Scenario,
  bootLimitMs: number,
): Promise<{ results: [CheckResult, CheckResult]; loadingMs: number | null }> {
  const { ctx } = input;
  const evidence = evidenceOf(input, 'web-smoke');
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

/** Check `web smoke` (`build` `## build-time check`, engines/godot.md `## web smoke`). Null when the build has no web platform. */
export async function webSmoke(input: ClientCheckInput): Promise<WebSmokeResult | null> {
  if (!input.platforms.includes('web')) return null;
  const { ctx } = input;
  const scenario = await readScenario(input.game.root);
  if (typeof scenario === 'string') return { check: buildCheckOf(NAME, input.env, both('client/dev/bot/scenario.json:1', scenario, false)), loadingMs: null };
  try {
    const chromium = await toolProgram(ctx, 'chromium');
    if (chromium === null) return { check: didNotRun(NAME, input.env, 'harness settings tools.chromium is not on this host'), loadingMs: null };
    const { webSmokeCpuThrottleRate: rate, webSmokeBootTimeoutMs: bootLimitMs } = await ctx.settings();
    return await withCheckInstance(ctx, input.game, 'web', (instance, external) =>
      withCheckExport(input, 'web', launchValuesOf(instance, external, 'web'), async (file) => {
        const host = await serveFolder(dirname(file));
        try {
          const page = await openHeadless(ctx, chromium, `${host.url}/index.html`, rate);
          try {
            const { results, loadingMs } = await smoke(input, instance, page, scenario, bootLimitMs);
            return { check: ranToEnd(NAME, input.env, buildCheckOf(NAME, input.env, results)), loadingMs };
          } finally {
            await page.close();
          }
        } finally {
          await host.close();
        }
      }),
    );
  } catch (error) {
    return { check: didNotRun(NAME, input.env, error), loadingMs: null };
  }
}
