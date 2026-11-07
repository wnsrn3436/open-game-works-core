import { constants } from 'node:fs';
import { createServer } from 'node:http';
import { cp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, normalize, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { exists, isNotFound } from '../../../lib/fsx.ts';
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
import { addCommitCheckout, removeCommitCheckout } from './atcommit.ts';
import type { BuildCheck } from './buildrun.ts';
import { godotCheckExport, godotCheckPrepare, type CheckPrepared, type LaunchValues } from './godot.ts';
import type { PlatformBuildInput } from './platform.ts';
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
  /** The check workspaces the checks of one build run share; a check without them makes its own. */
  workspaces?: CheckWorkspaces;
}

/**
 * A check that did not run (an export, instance, device or browser error, a program missing on this host): `unknown`
 * with that reason (`build` `## build-time check`). Errors that name an undefined step still stop the build run.
 */
export function didNotRun(name: string, error: unknown): BuildCheck {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('not defined:')) throw error;
  return { name, result: 'unknown', details: [`${name} did not run: ${message}`] };
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
 * failed): its `unknown` is a check that did not run to the end, whose lines say so (`build` `## build-time check`).
 */
export function ranToEnd(name: string, check: BuildCheck): BuildCheck {
  if (check.result !== 'unknown') return check;
  return { name, result: 'unknown', details: check.details.map((line) => `${name} did not run to the end: ${line}`) };
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
    // an instance left running would take a slot and load the checks after this one: a stop that fails fails the check
    await stopInstance(ctx, instance.id);
  }
}

/** Launch values of ogw.md `### device performance` 3 and `### web smoke` 2. */
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

/** The platforms of the check exports. */
export type CheckPlatform = 'android' | 'web';

/** Makes the check export of a copy with the launch values of its check instance and returns its output file. */
export type CheckExporter = (values: LaunchValues) => Promise<string>;

/** A check workspace: its build workspace and what its copies export with. */
interface PreparedWorkspace {
  root: string;
  prepared: CheckPrepared;
}

/** The parts of a check workspace that a copy holds: the engine project and the folder its `client/resource` links to. */
const COPIED = ['client', 'resource'];

/**
 * The check workspaces of one build run (ogw.md `### client checks`): per platform one build workspace of the build
 * branch HEAD, prepared and imported once when a check first asks for it, whose copies the check exports are made in.
 * `close` removes them.
 */
export class CheckWorkspaces {
  private readonly made = new Map<CheckPlatform, Promise<PreparedWorkspace>>();
  private readonly roots: string[] = [];
  private readonly input: ClientCheckInput;

  constructor(input: ClientCheckInput) {
    this.input = input;
  }

  /** The check workspace of `platform`, made on the first call; its failure goes to every check that uses it. */
  prepare(platform: CheckPlatform): Promise<PreparedWorkspace> {
    let workspace = this.made.get(platform);
    if (workspace === undefined) {
      workspace = this.make(platform);
      this.made.set(platform, workspace);
    }
    return workspace;
  }

  private async make(platform: CheckPlatform): Promise<PreparedWorkspace> {
    const { ctx, game } = this.input;
    const engine = this.input.settings.engine ?? 'godot';
    if (engine !== 'godot') throw new OgwError(`not defined: the check export of engine ${engine}`);
    const head = await revParse(game.root, 'HEAD');
    if (head === null) throw new OgwError('the build branch has no commit');
    const repo = await addCommitCheckout(ctx, game, head, (path) => this.roots.push(path));
    return { root: repo.root, prepared: await godotCheckPrepare(ctx, this.build(platform, repo.root), platform, repo.root) };
  }

  private build(platform: CheckPlatform, outDir: string): PlatformBuildInput {
    const { game, settings } = this.input;
    return { game, env: 'DEV', version: this.input.exportVersion, platforms: [platform], settings, outDir, iosPrivacy: [], privacyManifest: null };
  }

  /**
   * Runs `use` with the exporter of a new copy `.ogw-copy/<name>/` of the check workspace of `platform`, whose export goes
   * to `.ogw-check/<name>/`. The copy is a clone where the file system has one (APFS, Btrfs, XFS) and a copy elsewhere,
   * with the times of the files kept, so that the engine finds nothing to import again. The copy and its export are
   * deleted when `use` ends, whatever its result.
   */
  async withCopy<T>(platform: CheckPlatform, name: string, use: (exportWith: CheckExporter) => Promise<T>): Promise<T> {
    const { root, prepared } = await this.prepare(platform);
    const copy = join(root, '.ogw-copy', name);
    const out = join(root, '.ogw-check', name);
    try {
      for (const part of COPIED.filter((p) => exists(join(root, p)))) {
        await cp(join(root, part), join(copy, part), { recursive: true, mode: constants.COPYFILE_FICLONE, preserveTimestamps: true, verbatimSymlinks: true });
      }
      return await use((values) => godotCheckExport(this.input.ctx, this.build(platform, out), platform, copy, out, values, prepared));
    } finally {
      await rm(copy, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  }

  /** Waits for the preparations, then removes the build workspaces. */
  async close(): Promise<void> {
    await Promise.allSettled(this.made.values());
    for (const root of this.roots) await removeCommitCheckout(this.input.ctx, this.input.game, root);
  }
}

/** Runs `use` with new check workspaces, removed when `use` ends whatever its result. */
export async function withCheckWorkspaces<T>(input: ClientCheckInput, use: (workspaces: CheckWorkspaces) => Promise<T>): Promise<T> {
  const workspaces = new CheckWorkspaces(input);
  try {
    return await use(workspaces);
  } finally {
    await workspaces.close();
  }
}

/** Runs `use` with an input that has check workspaces: those of `input`, or new ones for this call. */
export async function withWorkspacesOf<T>(input: ClientCheckInput, use: (input: ClientCheckInput & { workspaces: CheckWorkspaces }) => Promise<T>): Promise<T> {
  const { workspaces } = input;
  if (workspaces !== undefined) return use({ ...input, workspaces });
  return withCheckWorkspaces(input, (made) => use({ ...input, workspaces: made }));
}

/**
 * Runs `use` with the exporter of a new copy of the check workspace of `platform` (ogw.md `### client checks`): the copy
 * is made before `use` starts the check instance, and the export is made with its launch values.
 */
export async function withCheckCopy<T>(input: ClientCheckInput, platform: CheckPlatform, name: string, use: (exportWith: CheckExporter) => Promise<T>): Promise<T> {
  return withWorkspacesOf(input, (own) => own.workspaces.withCopy(platform, name, use));
}

export type BootOutcome = { kind: 'done'; at: number } | { kind: 'blocker'; message: string } | { kind: 'timeout'; message: string };

/**
 * Waits until the outside client connected to the automation channel and `boot_stage` is `Done`.
 * `Halted` and `blocker()` (checked after each `get_state`) end the wait as a blocker; requests fail while
 * the client is not connected, and the timeout message names the last failure.
 */
export async function waitClientBoot(
  ctx: Context,
  id: string,
  blocker: () => Promise<string | null>,
  limitMs: number = clientCheckTiming.bootLimitMs,
): Promise<BootOutcome> {
  const deadline = Date.now() + limitMs;
  let lastFailure: string | null = null;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) {
      const last = lastFailure === null ? '' : ` (last get_state: ${lastFailure})`;
      return { kind: 'timeout', message: `the client did not reach boot_stage Done within ${String(limitMs)} ms${last}` };
    }
    const asked = await automationRequest(ctx, id, 'get_state', [], 'main', { timeoutMs: Math.min(left, LIMITS.shortMs) }).then(
      (answer) => ({ response: answer, failure: null }),
      (error: unknown) => ({ response: null, failure: (error as Error).message }),
    );
    if (asked.failure !== null) lastFailure = asked.failure;
    const response = asked.response;
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
      (error: unknown) => {
        // no such file (or a folder): 404; a file that cannot be read is a server error the page sees
        const missing = isNotFound(error) || (error as NodeJS.ErrnoException).code === 'EISDIR';
        res.writeHead(missing ? 404 : 500).end(missing ? undefined : (error as Error).message);
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
