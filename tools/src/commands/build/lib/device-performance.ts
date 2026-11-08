import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { run, runOk } from '../../../lib/proc.ts';
import { checkResult, failure, writeEvidence } from '../../check/lib/evidence.ts';
import { readScenario } from '../../check/lib/bot-playtest.ts';
import { clientErrorLines, clientLog } from '../../check/lib/logs.ts';
import { measureScenario, performanceVerdict } from '../../check/lib/performance.ts';
import type { Scenario } from '../../check/lib/scenario.ts';
import { lanAddress, udpReaches } from '../../env/lib/hostcheck.ts';
import { gameModules } from '../../generate/api.ts';
import type { ExternalClient, InstanceInfo } from '../../instance/api.ts';
import type { BuildCheck } from './buildrun.ts';
import {
  atGate,
  buildCheckOf,
  checkoutOf,
  clientCheckTiming,
  didNotRun,
  ranToEnd,
  evidenceOf,
  NO_GATE,
  waitClientBoot,
  withCheckCopy,
  withCheckInstance,
  type ClientCheckInput,
  type MeasureGate,
} from './client-check.ts';

const NAME = 'device performance';

function unknown(detail: string): BuildCheck {
  return { name: NAME, result: 'unknown', details: [detail] };
}

function numberSetting(input: ClientCheckInput, key: string): number {
  const value = input.settings[key];
  if (typeof value !== 'number') throw new OgwError(`game settings ${key} is not set`);
  return value;
}

async function adb(ctx: Context, serial: string, args: string[], timeoutMs: number = LIMITS.shortMs): Promise<string> {
  return (await runOk('adb', ['-s', serial, ...args], { env: ctx.env, timeoutMs })).stdout;
}

/**
 * Blocker of the app on the device: its process ended, or an error level line in its client log. A client log that
 * cannot be read throws `ClientLogUnreadable`: it is not a log without error lines. An `adb` that cannot be started
 * throws: it is not an ended app.
 */
export function appBlocker(ctx: Context, serial: string, appId: string, instanceId: string): () => Promise<string | null> {
  return async () => {
    const pid = await run('adb', ['-s', serial, 'shell', 'pidof', appId], { env: ctx.env, timeoutMs: LIMITS.shortMs });
    if (pid.code !== 0 || pid.stdout.trim() === '') return 'client process main ended';
    const line = clientErrorLines(await clientLog(ctx, instanceId, 'main'))[0];
    return line === undefined ? null : `client main error log: ${line}`;
  };
}

interface DeviceRun {
  input: ClientCheckInput;
  serial: string;
  appId: string;
  scenario: Scenario;
  instance: InstanceInfo;
  external: ExternalClient;
}

/**
 * ogw.md `### device performance` 4–5 with the exported apk: install, port reverse, launch, the `performance` verdict,
 * uninstall.
 */
async function onDevice(d: DeviceRun, apk: string): Promise<BuildCheck> {
  const { ctx } = d.input;
  const ports = [new URL(d.instance.serverUrl).port, String(d.external.automationPort)];
  try {
    await adb(ctx, d.serial, ['install', '-r', apk], LIMITS.programMs);
    for (const port of ports) await adb(ctx, d.serial, ['reverse', `tcp:${port}`, `tcp:${port}`]);
    await adb(ctx, d.serial, ['shell', 'monkey', '-p', d.appId, '-c', 'android.intent.category.LAUNCHER', '1']);
    const blocker = appBlocker(ctx, d.serial, d.appId, d.instance.id);
    const boot = await waitClientBoot(ctx, d.instance.id, blocker);
    // the app did not boot on the device (crash, halt, error log, time limit): a blocker, not an unknown
    if (boot.kind !== 'done') return buildCheckOf(NAME, d.input.env, [checkResult('performance', 'android', [failure('boot', boot.message)])]);
    const quality = (await gameModules(ctx, d.input.game)).client.includes('QualityCore');
    const targetFps = numberSetting(d.input, 'targetFps');
    const measured = await measureScenario(ctx, d.instance.id, d.scenario, { quality, pollMs: clientCheckTiming.pollMs, targetFps, onHost: false, blocker });
    if (measured.kind === 'quality') return ranToEnd(NAME, buildCheckOf(NAME, d.input.env, [checkResult('performance', 'android', [failure('', measured.message)], true)]));
    const record = { device: d.serial, samples: Object.fromEntries(measured.samples), frameIntervals: Object.fromEntries(measured.frames), scene_loads: measured.sceneLoads };
    const evidence = [await writeEvidence(evidenceOf(d.input, 'device-performance'), 'samples.json', `${JSON.stringify(record, null, 2)}\n`)];
    const limits = { loadingTimeLimitMs: numberSetting(d.input, 'loadingTimeLimitMs') };
    return ranToEnd(NAME, buildCheckOf(NAME, d.input.env, [performanceVerdict(measured, 'android', limits, evidence)]));
  } finally {
    // their exit codes are not checked (the app or a reverse may not be there yet); an adb that cannot be started fails the check
    await run('adb', ['-s', d.serial, 'uninstall', d.appId], { env: ctx.env, timeoutMs: LIMITS.shortMs });
    for (const port of ports) await run('adb', ['-s', d.serial, 'reverse', '--remove', `tcp:${port}`], { env: ctx.env, timeoutMs: LIMITS.shortMs });
  }
}

/**
 * ogw.md `### device performance` 2: whether UDP from the device reaches this host (`ogw env check`); null when the
 * device could not be asked (`adb shell` did not run, ended with another code or gave no answer in time).
 */
async function udpReachesHost(ctx: Context, serial: string): Promise<boolean | null> {
  const address = lanAddress();
  return address === null ? false : udpReaches(ctx, serial, address);
}

/**
 * Check `device performance` (`build` `## build-time check`, ogw.md `### device performance`):
 * the bot playtest scenario on the first android device of harness settings `testDevices` with the DEV
 * export of the build branch HEAD, judged by ogw.md `## performance`. Null when the build has no android platform. Its
 * check instance and apk export come first; the app goes to the device when `gate` lets it measure.
 */
export async function devicePerformance(input: ClientCheckInput, gate: MeasureGate = NO_GATE): Promise<BuildCheck | null> {
  const { ctx } = input;
  if (!input.platforms.includes('android')) return null;
  // harness settings `testDevices` holds android devices only (`platform` is `android`)
  const device = ((await ctx.settings()).testDevices ?? [])[0];
  if (device === undefined) return unknown('harness settings testDevices has no android device');
  const scenario = await readScenario(checkoutOf(input));
  if (typeof scenario === 'string') return buildCheckOf(NAME, input.env, [checkResult('performance', 'android', [failure('client/dev/bot/scenario.json:1', scenario)])]);
  const appId = input.settings.appId;
  if (typeof appId !== 'string' || appId === '') throw new OgwError('game settings appId is not set');
  try {
    const realtime = (await gameModules(ctx, input.game)).client.includes('RealtimeCore');
    return await withCheckCopy(input, 'android', 'android', (exportWith) =>
      withCheckInstance(ctx, input.game, 'android', async (instance, external, values) => {
        const udp = realtime ? await udpReachesHost(ctx, device.serial) : true;
        // UDP that does not reach and a device that cannot be asked are both `unknown`, each with its reason
        if (udp === null) return didNotRun(NAME, `the UDP check from test device ${device.serial} could not run`);
        if (!udp) return unknown(`UDP from test device ${device.serial} does not reach this host`);
        const d: DeviceRun = { input, serial: device.serial, appId, scenario, instance, external };
        const apk = await exportWith(values);
        await atGate(gate);
        return onDevice(d, apk);
      }));
  } catch (error) {
    return didNotRun(NAME, error);
  }
}
