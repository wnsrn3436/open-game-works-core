import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, normalize, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { revParse } from '../../../lib/git.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { isInside } from '../../../lib/paths.ts';
import type { GameSettings } from '../../../lib/settings.ts';
import type { CheckResult } from '../../check/api.ts';
import type { Evidence } from '../../check/lib/evidence.ts';
import { contentTypeOf } from '../../deploy/lib/s3.ts';
import { startInstance, stopInstance, type ExternalClient, type InstanceInfo } from '../../instance/api.ts';
import { automationRequest } from '../../instance/automation.ts';
import { START_LIMIT_MS } from '../../instance/lib/supervisor.ts';
import { withCommitCheckout } from './atcommit.ts';
import type { BuildCheck } from './buildrun.ts';
import { godotCheckExport, type LaunchValues } from './godot.ts';
import { buildDirName, type Env } from './names.ts';
import { outcome } from './settingschecks.ts';

/** Poll interval and the time limit of the first boot of a device or browser client. Tests shorten them. */
export const clientCheckTiming = { pollMs: 200, bootLimitMs: START_LIMIT_MS };

/** What check `device performance` and `web smoke` need from the build run. */
export interface ClientCheckInput {
  ctx: Context;
  game: GameRepo;
  env: Env;
  /** `<version>` or `<app version>-bundle-<n>`: the `builds/` folder name part. */
  version: string;
  /** Version written into the DEV export (`<app version>` for a bundle patch build). */
  exportVersion: string;
  settings: GameSettings;
  platforms: string[];
}

/**
 * A check that did not run (an export, instance, device or browser error): it blocks a STG or PROD build and warns in
 * DEV (`build` `## build-time check`). Errors that name an undefined step still stop the build run.
 */
export function didNotRun(name: string, env: Env, error: unknown): BuildCheck {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('not defined:')) throw error;
  const details = [`${name} did not run: ${message}`];
  return { name, result: outcome(name, env, details), details };
}

/** `builds/<env>-<version>/<name>/` as check evidence (game repo relative paths). */
export function evidenceOf(input: ClientCheckInput, name: string): Evidence {
  return { root: input.game.root, dir: `builds/${buildDirName(input.env, input.version)}/${name}`, relative: true };
}

function failureLine(failure: { where: string; message: string }): string {
  return failure.where === '' ? failure.message : `${failure.where}: ${failure.message}`;
}

/**
 * A build check from check results: `fail` (DEV: `warn`) when one failed, else `unknown` when one is
 * unknown, else `pass`.
 */
export function buildCheckOf(name: string, env: Env, results: readonly CheckResult[]): BuildCheck {
  const details = results.flatMap((r) => r.failures.map((f) => (results.length > 1 ? `${r.name}: ${failureLine(f)}` : failureLine(f))));
  if (results.some((r) => r.result === 'fail')) return { name, result: outcome(name, env, details), details };
  if (results.some((r) => r.result === 'unknown')) return { name, result: 'unknown', details };
  return { name, result: 'pass', details: [] };
}

/**
 * A build check of a run that stopped before its end (the scenario stopped without a blocker, a step or a quality level
 * failed): `unknown` here is a check that did not run to the end, which the table does not mark `unknown`, so it is
 * `didNotRun` (`build` `## build-time check`).
 */
export function ranToEnd(name: string, env: Env, check: BuildCheck): BuildCheck {
  if (check.result !== 'unknown') return check;
  const details = check.details.map((line) => `${name} did not run to the end: ${line}`);
  return { name, result: outcome(name, env, details), details };
}

/** Runs `work` on an instance without a client that is not a bot client, whose automation channel `main` waits for an outside client. */
export async function withCheckInstance<T>(
  ctx: Context,
  game: GameRepo,
  platform: string,
  work: (instance: InstanceInfo, external: ExternalClient) => Promise<T>,
): Promise<T> {
  const instance = await startInstance(ctx, { game: game.name, client: 'none', externalClient: true, platform });
  try {
    if (instance.external === null) throw new OgwError(`instance ${instance.id} has no automation channel for the client`);
    return await work(instance, instance.external);
  } finally {
    await stopInstance(ctx, instance.id).catch((error: unknown) => {
      ctx.log(`cannot stop instance ${instance.id}: ${(error as Error).message}`);
    });
  }
}

/** Launch values of `## device performance` 3 and `## web smoke` 2. */
export function launchValuesOf(instance: InstanceInfo, external: ExternalClient, platform: string): LaunchValues {
  return {
    OGW_SERVER_URL: `http://127.0.0.1:${new URL(instance.serverUrl).port}`,
    OGW_INSTANCE_ID: instance.id,
    OGW_AUTOMATION_PORT: String(external.automationPort),
    OGW_AUTOMATION_TOKEN: external.automationToken,
    OGW_PLATFORM: platform,
    OGW_DEV_ACCESS: external.devAccess,
    OGW_DEV_ACCOUNT: external.devAccount,
  };
}

/**
 * The DEV export of the build branch HEAD in a build workspace, then `use` on the output file. The export
 * and `generated/launch_values.json` are deleted when `use` ends, whatever its result.
 */
export async function withCheckExport<T>(
  input: ClientCheckInput,
  platform: 'android' | 'web',
  values: LaunchValues,
  use: (file: string) => Promise<T>,
): Promise<T> {
  const { ctx, game } = input;
  const engine = input.settings.engine ?? 'godot';
  if (engine !== 'godot') throw new OgwError(`not defined: the check export of engine ${engine}`);
  const head = await revParse(game.root, 'HEAD');
  if (head === null) throw new OgwError('the build branch has no commit');
  return withCommitCheckout(ctx, game, head, async (repo) => {
    const dir = join(repo.root, '.ogw-check', platform);
    const build = { game, env: 'DEV' as const, version: input.exportVersion, platforms: [platform], settings: input.settings, outDir: dir, iosPrivacy: [], privacyManifest: null };
    try {
      return await use(await godotCheckExport(ctx, build, platform, repo.root, dir, values));
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(join(repo.root, 'client', 'generated', 'launch_values.json'), { force: true });
    }
  });
}

export type BootOutcome = { kind: 'done'; at: number } | { kind: 'blocker'; message: string } | { kind: 'timeout'; message: string };

/**
 * Waits until the outside client connected to the automation channel and `boot_stage` is `Done`.
 * `Halted` and `blocker()` (checked after each `get_state`) end the wait as a blocker; requests fail while
 * the client is not connected.
 */
export async function waitClientBoot(
  ctx: Context,
  id: string,
  blocker: () => Promise<string | null>,
  limitMs: number = clientCheckTiming.bootLimitMs,
): Promise<BootOutcome> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return { kind: 'timeout', message: `the client did not reach boot_stage Done within ${String(limitMs)} ms` };
    const response = await automationRequest(ctx, id, 'get_state', [], 'main', { timeoutMs: Math.min(left, LIMITS.shortMs) }).catch(() => null);
    const stop = await blocker();
    if (stop !== null) return { kind: 'blocker', message: stop };
    const stage = response?.ok === true ? (response.result as { boot_stage?: unknown } | null)?.boot_stage : undefined;
    if (stage === 'Done') return { kind: 'done', at: Date.now() };
    if (stage === 'Halted') return { kind: 'blocker', message: 'boot_stage is Halted' };
    await sleep(clientCheckTiming.pollMs);
  }
}

/** Serves a folder over HTTP on a free port of `127.0.0.1`. */
export async function serveFolder(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const file = normalize(join(dir, path === '/' ? 'index.html' : path));
    if (req.method !== 'GET' || !isInside(dir, file) || relative(dir, file) === '') {
      res.writeHead(404).end();
      return;
    }
    readFile(file).then(
      (content) => {
        res.writeHead(200, { 'content-type': contentTypeOf(file) }).end(content);
      },
      () => {
        res.writeHead(404).end();
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
