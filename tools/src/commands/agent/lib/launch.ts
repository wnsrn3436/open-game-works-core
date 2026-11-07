import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
import { addRunLogFields, agentCliEnded, markAgentRunning, newAgentKey } from '../../../lib/agentctx.ts';
import type { CommandResult, Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import { BROKER_ENV, BROKER_RUN, BROKER_WORKER } from '../../../lib/broker-client.ts';
import { commitPaths, commonDir, gitDir, gitIdentity, gitLine, head, withGitConfig, worktreeAdd, worktreeRemove } from '../../../lib/git.ts';
import { AGENT_KEY_ENV, endJobsOfAgent, jobsDir, listJobs } from '../../../lib/jobs.ts';
import { withLock } from '../../../lib/lock.ts';
import { escapeRegExp } from '../../../lib/regexp.ts';
import { cliEntry, harnessRoot } from '../../../lib/paths.ts';
import { newPrivateTempFolder, privateTempDir, secretFilesDir } from '../../../lib/secret-files.ts';
import { secretStoreFolders } from '../../../lib/secrets.ts';
import { moveOldSecrets } from '../../secret/lib/move.ts';
import { storedLoginToken } from '../../secret/lib/login-token.ts';
import type { AgentSettings, Workspace } from '../../../lib/settings.ts';
import { killTree, processStartedAt, spawnTracked } from '../../../lib/proc.ts';
import { REFERENCE_DIR } from '../../game/reference.ts';
import { startBroker, type Broker } from './broker.ts';
import {
  agentCli,
  agentCliCommand,
  agentResumeCommand,
  firstRunCommand,
  agentHomeBlocked,
  agentLoginWrites,
  agentSettings,
  dockerBlocked,
  localSocketsBlocked,
  MACOS_DNS_SOCKET,
  macosProfile,
  makeBlocked,
  sandboxed,
  SANDBOX_DROPPED_ENV,
  userServicesBlocked,
  withoutSessionFiles,
  macosFoldersProfile,
  type AgentCli,
  type AgentSession,
  type Blocked,
  type CliCommand,
} from './cli-command.ts';
import { AGENT_TEMP_FOLDER, agentFolderPrefix, move, osTempFolder } from './files.ts';
import { AGENT_LOG_FOLDER, agentCliLog, changeAgentMeta, FIX_ROUND_ROLES, jobAgentSettings, jobHarnessSettings, readAgentJob, type AgentMeta } from './meta.ts';
import { buildPrompt } from './prompt.ts';
import { instancesDir } from '../../instance/lib/records.ts';
import { stopInstancesOfAgent } from '../../instance/api.ts';
import { readTranslationFiles } from './translation-files.ts';
import { translationCounts } from './rowmerge.ts';
import { codexThreadId, jobUsage, runsUsage, sessionUsageOf, withResultText, type SessionUsage } from './usage.ts';
import { fixRoundPrompt, resultFormatErrors } from './result-format.ts';

/** The pre-commit hook command core worktrees need. */
export const PRE_COMMIT_COMMAND = 'meta sync core --staged';

/**
 * Installs a pre-commit hook running `ogw meta sync core --staged` in the repo's hook folder when there is none. The
 * hook runs the `ogw` of this code, which finds node in PATH, so that no node upgrade removes what it runs, and names
 * the harness of `env`, so that it syncs in that harness's workspace whatever environment commits.
 */
export async function ensurePreCommitHook(repo: string, env: NodeJS.ProcessEnv): Promise<void> {
  const hooks = resolve(repo, await gitLine(repo, ['rev-parse', '--git-path', 'hooks']));
  const hook = join(hooks, 'pre-commit');
  // a shell assignment, not `env`, which would take a path holding `=` for one
  const root = `OGW_HARNESS_ROOT="${harnessRoot(env)}"`;
  const command = `"${join(ogwBinFolder(), 'ogw')}" ${PRE_COMMIT_COMMAND}`;
  if (exists(hook)) {
    const current = await readFile(hook, 'utf8');
    if (current.includes(PRE_COMMIT_COMMAND)) return;
    const [first, ...rest] = current.split('\n');
    const line = `${root} ${command} || exit 1`;
    const text = first?.startsWith('#!') ? [first, line, ...rest].join('\n') : `${line}\n${current}`;
    await writeFileAtomic(hook, text);
  } else {
    await writeFileAtomic(hook, `#!/bin/sh\n${root} exec ${command}\n`);
  }
  await chmod(hook, 0o755);
}

/**
 * Links into a game worktree the files of the checkout's `records/setup/reference/` that git does not hold: the
 * reference videos, third-party works kept out of git (`ogw game init`), so that an agent in the worktree can look at
 * them with `ogw frames` like one in the checkout.
 */
async function linkReferenceVideos(checkout: string, worktree: string): Promise<void> {
  const from = join(checkout, REFERENCE_DIR);
  if (!exists(from)) return;
  const to = join(worktree, REFERENCE_DIR);
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) {
    if (!exists(join(to, name))) await symlink(join(from, name), join(to, name));
  }
}

/** Makes the agent's worktree and sets the folder and result file path in the job meta. */
async function makePlace(id: string, ctx: Context, meta: AgentMeta): Promise<AgentMeta> {
  const place = meta.place;
  let worktree: string | null = null;
  if (place.kind === 'game-worktree') {
    worktree = join(place.worktrees, meta.game as string, `agent-${id}`);
    await worktreeAdd(place.checkout, worktree, place.baseCommit, `agent/${id}`, { env: ctx.env });
    await linkReferenceVideos(place.checkout, worktree);
  } else if (place.kind === 'core-worktree') {
    await ensurePreCommitHook(place.coreImpl, ctx.env);
    worktree = join(place.worktrees, '_core', `agent-${id}`);
    await worktreeAdd(place.coreImpl, worktree, place.baseCommit, `agent/${id}`, { env: ctx.env });
    // A review file of the same name from an earlier review (`--restart`, a later `update core`) is on main: remove it
    // so that only a file this agent writes counts as its result.
    if (meta.role === 'review' && meta.outputRel !== null) await rm(join(worktree, meta.outputRel), { force: true });
  }
  const toolWorktree = place.kind === 'tool-worktree' ? await newPrivateTempFolder('ogw-tool-review-', ctx.env) : null;
  try {
    if (place.kind === 'tool-worktree' && toolWorktree !== null) {
      worktree = toolWorktree;
      await worktreeAdd(place.harness, toolWorktree, place.baseCommit, undefined, { env: ctx.env });
    }
    return await changeAgentMeta(id, ctx.env, (m) => {
      if (worktree !== null) {
        m.worktree = worktree;
        m.folder = worktree;
        if (place.kind !== 'tool-worktree') m.branch = `agent/${id}`;
      }
      if (m.outputRel !== null && worktree !== null) m.output = join(worktree, m.outputRel);
    });
  } catch (error) {
    if (place.kind === 'tool-worktree' && toolWorktree !== null) await removeToolWorktree(place.harness, toolWorktree, ctx.env);
    throw error;
  }
}

/** Removes a tool review worktree: from the harness repo's worktree list and from disk. */
async function removeToolWorktree(harness: string, worktree: string, env: NodeJS.ProcessEnv): Promise<void> {
  await worktreeRemove(harness, worktree, { env });
  await rm(worktree, { recursive: true, force: true });
}

/**
 * After a step of the job threw: removes what no later command uses, the play or judge agent folder and the tool
 * review worktree (ogw.md `## temp folder`). Game and core worktrees stay for `ogw agent retry` and `merge`.
 */
async function removeTempPlace(ctx: Context, meta: AgentMeta): Promise<void> {
  const place = meta.place;
  if (place.kind === 'temp') await rm(place.dir, { recursive: true, force: true });
  else if (place.kind === 'tool-worktree' && meta.worktree !== null) await removeToolWorktree(place.harness, meta.worktree, ctx.env);
}

/** The environment of the agent CLI: without the job id and the key of the agent that started this job, with its own key. */
function childEnv(env: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env, [AGENT_KEY_ENV]: key };
  delete copy.OGW_JOB_ID;
  return copy;
}

interface CliRun {
  code: number | null;
  error: string | null;
}

/** The folder of the jobs folder that holds one broker folder (`<job id>/`, with the socket `s`) per play or judge agent. */
export const BROKERS_FOLDER = 'brokers';

/** The broker socket of play or judge agent job `id`: `<jobs folder>/brokers/<id>/s`. */
export async function brokerSocket(id: string, env: NodeJS.ProcessEnv): Promise<string> {
  return join(await jobsDir(env), BROKERS_FOLDER, id, 's');
}

/** The folders the sandboxes read from settings: the harness repo, core, games and worktrees. */
export type SandboxWorkspace = Pick<Workspace, 'harness' | 'coreImpl' | 'coreReleases' | 'games' | 'worktrees' | 'regress'>;

/** The harness repos: the one `OGW_HARNESS_ROOT` or this code's location names, and the one this code runs from. */
function harnessRepos(ws: SandboxWorkspace): string[] {
  return [...new Set([ws.harness, resolve(dirname(cliEntry()), '..', '..')])];
}

/**
 * The git common dirs of the harness repos (instance records, jobs, secret files, hooks). A repo whose common dir cannot
 * be read fails the sandbox build: a block list without it would let the agent reach those folders.
 */
export async function harnessGitDirs(ws: SandboxWorkspace, env: NodeJS.ProcessEnv): Promise<string[]> {
  const dirs = await Promise.all(harnessRepos(ws).map((repo) => commonDir(repo, { env })));
  return [...new Set(dirs)];
}

/**
 * The roles of one game that run with the other games blocked, besides play and judge. Not `resource`: `ogw generation run`
 * runs its local models in a sandbox of their own, and macOS does not start a sandbox inside another.
 */
const OTHER_GAMES_BLOCKED_ROLES: readonly string[] = ['content', 'translation', 'server-hardening', 'client-hardening'];

/** The OSes `sandboxed` runs on. */
const SANDBOX_PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'linux'];

/** The folders directly under `parent` whose names are not in `keep`; none when `parent` does not exist. */
async function foldersUnder(parent: string, keep: readonly string[]): Promise<string[]> {
  if (!exists(parent)) return [];
  const entries = await readdir(parent, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !keep.includes(e.name)).map((e) => join(parent, e.name));
}

/** The worktree folder of the side worktrees of the regression suite (ogw.md `### side` of `## regress`). */
export const SIDE_WORKTREES = '_harness';

/**
 * The folders of the other games and the seeds of the regression suite: repos under `paths.games`, worktree folders
 * under `paths.worktrees` but those of core and of the sides, the regress repo, and `regress/` of the harness repos and
 * of the side worktrees, each when it exists.
 */
export async function otherGameFolders(ws: SandboxWorkspace, game: string): Promise<string[]> {
  const harnesses = [...harnessRepos(ws), ...(await foldersUnder(join(ws.worktrees, SIDE_WORKTREES), []))];
  const seeds = [ws.regress, ...harnesses.map((harness) => join(harness, 'regress'))].filter((path) => exists(path));
  return [...(await foldersUnder(ws.games, [game])), ...(await foldersUnder(ws.worktrees, [game, '_core', SIDE_WORKTREES])), ...seeds];
}

/**
 * What both the agent sandbox and the broker sandbox block. Reading and writing: the games and worktrees, the
 * instance records and folders, the agent logs and the broker folders of the jobs folder, the secret files, the temp
 * folder of ogw, the secret store folders, the session stores in the agent CLI config folders, and the unix
 * sockets of Docker, the SSH agent, tmux and (Linux) the user's services. Writing:
 * the harness repos, `open-game-works-core-impl/` and `open-game-works-core-releases/`.
 */
async function sharedBlocked(ws: SandboxWorkspace, env: NodeJS.ProcessEnv): Promise<Blocked> {
  const homes = agentHomeBlocked(env);
  const docker = dockerBlocked(env);
  const local = localSocketsBlocked(env);
  const services = userServicesBlocked(env);
  const jobs = await jobsDir(env);
  return {
    folders: [
      ws.games,
      ws.worktrees,
      await instancesDir(env),
      join(jobs, AGENT_LOG_FOLDER),
      join(jobs, BROKERS_FOLDER),
      await secretFilesDir(env),
      await privateTempDir(env),
      ...secretStoreFolders(env),
      ...homes.folders,
    ],
    files: homes.files,
    ...(homes.hidden === undefined ? {} : { hidden: homes.hidden }),
    sockets: [...(docker.sockets ?? []), ...(local.sockets ?? []), ...(services.sockets ?? [])],
    socketFolders: [...(docker.socketFolders ?? []), ...(local.socketFolders ?? []), ...(services.socketFolders ?? [])],
    readOnly: [...harnessRepos(ws), ws.coreImpl, ws.coreReleases],
  };
}

/**
 * Where both sandboxes write: the agent folder, the OS temp folders (`TMPDIR`, else the OS default, and `/tmp`), and
 * the login of the agent CLIs (`agentLoginWrites`). Nothing else in home: not the git, shell and agent CLI config
 * that a process outside the sandbox later reads and runs.
 */
function allowedWrites(env: NodeJS.ProcessEnv, folder: string | null): NonNullable<Blocked['allowedWrites']> {
  const login = agentLoginWrites(env);
  return { folders: [...(folder === null ? [] : [folder]), ...osTemps(env), ...login.folders], files: login.files };
}

/** The OS temp folders both sandboxes write: `TMPDIR`, else the OS default, and `/tmp`. */
function osTemps(env: NodeJS.ProcessEnv): string[] {
  return [...new Set([osTempFolder(env), '/tmp'])];
}

/**
 * What both sandboxes block of the other play and judge agents: their folders directly under the OS temp folders, and
 * on macOS what is below Claude Code's temp root of the login's uid. The agent's own folder (`folder`) stays open.
 */
function otherAgentFolders(env: NodeJS.ProcessEnv, folder: string | null): NonNullable<Blocked['agentFolders']> {
  const uid = process.getuid?.();
  return {
    temps: osTemps(env),
    prefixes: SANDBOXED_ROLES.map(agentFolderPrefix),
    own: folder,
    ...(uid === undefined ? {} : { claudeTemp: `/tmp/claude-${String(uid)}` }),
  };
}

/**
 * The agent sandbox of play and judge: `sharedBlocked`, the whole jobs folder and harness git common dir, and on
 * macOS the local network and every unix socket but the broker's and DNS. The agent's own CLI log (its job process
 * opens it outside the sandbox) and broker folder stay open.
 */
async function agentBlocked(
  ws: SandboxWorkspace,
  env: NodeJS.ProcessEnv,
  writes: NonNullable<Blocked['allowedWrites']>,
  agentFolders: NonNullable<Blocked['agentFolders']>,
  cliLog: string | null,
  socket: string | null,
): Promise<Blocked> {
  const shared = await sharedBlocked(ws, env);
  return {
    ...shared,
    allowedWrites: writes,
    agentFolders,
    folders: [...shared.folders, await jobsDir(env), ...(await harnessGitDirs(ws, env))],
    except: cliLog === null ? [] : [cliLog],
    exceptFolders: socket === null ? [] : [dirname(socket)],
    localNetwork: { allowSockets: [...(socket === null ? [] : [socket]), MACOS_DNS_SOCKET] },
  };
}

/** The broker sandbox the forwarded `ogw` commands run in: `sharedBlocked`, with the jobs folder writable. */
async function brokerBlocked(
  ws: SandboxWorkspace,
  env: NodeJS.ProcessEnv,
  writes: NonNullable<Blocked['allowedWrites']>,
  agentFolders: NonNullable<Blocked['agentFolders']>,
): Promise<Blocked> {
  return { ...(await sharedBlocked(ws, env)), allowedWrites: writes, agentFolders, writable: [await jobsDir(env)] };
}

/**
 * play, judge: the environment of the agent CLI and of the commands its broker runs: without the variables
 * `SANDBOX_DROPPED_ENV` names and the broker socket, and with `TMPDIR` in the agent folder, when there is one.
 */
function agentEnv(env: NodeJS.ProcessEnv, folder: string | null): NodeJS.ProcessEnv {
  const kept = sandboxEnv(env);
  return folder === null ? kept : { ...kept, TMPDIR: join(folder, AGENT_TEMP_FOLDER) };
}

/** play, judge: the environment without the variables `SANDBOX_DROPPED_ENV` names and the broker socket. */
function sandboxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SANDBOX_DROPPED_ENV.includes(name) && name !== BROKER_ENV));
}

/**
 * play, judge with Claude Code: `CLAUDE_CODE_OAUTH_TOKEN` with the harness secret `claude-code-oauth-token` when the
 * host secret store has it, so the CLI does not renew its login inside the sandbox (`tools/ogw.md` `## agent`).
 */
function loginTokenEnv(ctx: Context, agent: AgentSettings): NodeJS.ProcessEnv {
  if (agentCli(agent) !== 'claude-code') return {};
  const token = storedLoginToken(ctx);
  return token === null ? {} : { CLAUDE_CODE_OAUTH_TOKEN: token };
}

/** How long Claude Code in print mode waits for its background tasks after the last turn (`tools/ogw.md` `## agent`). */
export const CLAUDE_BACKGROUND_WAIT_MS = 60 * 60_000;

/**
 * Claude Code of the roles other than play and judge: `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` with
 * `CLAUDE_BACKGROUND_WAIT_MS`. With its default of 10 minutes the CLI stopped a content sub-agent of the `Agent` tool
 * that was still writing, and the stopped sub-agent sent no completion notice. Play and judge keep the default, so that
 * a background task left running ends before their time limit.
 */
function backgroundWaitEnv(agent: AgentSettings): NodeJS.ProcessEnv {
  return agentCli(agent) === 'claude-code' ? { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(CLAUDE_BACKGROUND_WAIT_MS) } : {};
}

/** The folder of the `ogw` wrapper of this code: the harness `tools/bin`. */
function ogwBinFolder(): string {
  return resolve(dirname(cliEntry()), '..', 'bin');
}

/** The environment with the harness `tools/bin` first on `PATH`, so the agent's shell finds `ogw` by name. */
export function withOgwOnPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bin = ogwBinFolder();
  const rest = (env.PATH ?? '').split(delimiter).filter((dir) => dir !== '' && dir !== bin);
  return { ...env, PATH: [bin, ...rest].join(delimiter) };
}

/** The roles whose agent CLI `ogw agent` runs in the OS sandbox. */
export const SANDBOXED_ROLES: readonly string[] = ['play', 'judge'];

export interface CliToRun {
  command: CliCommand;
  /** An agent CLI command (`agentCliCommand`, `agentResumeCommand`) in the sandbox `command` runs in. */
  wrap: (cli: CliCommand) => CliCommand;
  /** The environment the command runs with. */
  env: NodeJS.ProcessEnv;
  /** A sandboxed role, or a role with other games to block: folder with the sandbox profiles in the temp folder of ogw; the caller removes it. */
  profileFolder: string | null;
  /** play, judge with a broker: the command that runs a forwarded argv in the broker sandbox. */
  brokerCommand: ((argv: readonly string[]) => CliCommand) | null;
  /** play, judge with a broker: the broker worker in the broker sandbox, which runs the frequent commands. */
  brokerWorker: CliCommand | null;
}

/**
 * The agent CLI command of `ogw agent` and `ogw env check`; for play and judge in the agent sandbox, with the
 * default config folder (the user's login) and no session file of its own. `cliLog` is the file the CLI output goes
 * to when it is under the agent log folder (`ogw agent`), else null. `socket` is the broker socket (`ogw agent`),
 * else null. `folder` is the folder the agent starts in (`ogw agent`, the play and judge run of `ogw env check`), whose
 * `tmp/` the CLI gets as `TMPDIR`, else null. `game` is the game of the agent, whose role blocks the other games.
 */
export async function cliToRun(
  ctx: Context,
  role: string,
  agent: AgentSettings,
  ws: SandboxWorkspace,
  cliLog: string | null,
  socket: string | null = null,
  folder: string | null = null,
  game: string | null = null,
): Promise<CliToRun> {
  const command = agentCliCommand(agent);
  if (!SANDBOXED_ROLES.includes(role)) {
    const env = { ...withOgwOnPath(ctx.env), ...backgroundWaitEnv(agent) };
    const blocksOthers = game !== null && OTHER_GAMES_BLOCKED_ROLES.includes(role) && SANDBOX_PLATFORMS.includes(process.platform);
    const others = blocksOthers ? await otherGameFolders(ws, game) : [];
    if (others.length === 0) return { command, wrap: (cli) => cli, env, profileFolder: null, brokerCommand: null, brokerWorker: null };
    const profileFolder = await newPrivateTempFolder(`ogw-${role}-sandbox-`, ctx.env);
    try {
      const profileFile = join(profileFolder, 'sandbox.sb');
      await writeFile(profileFile, macosFoldersProfile(others));
      const wrap = (cli: CliCommand): CliCommand => sandboxed(cli, { folders: others, files: [] }, { macosProfileFile: profileFile, pidNamespace: false });
      return {
        command: wrap(command),
        wrap,
        env,
        profileFolder,
        brokerCommand: null,
        brokerWorker: null,
      };
    } catch (error) {
      await rm(profileFolder, { recursive: true, force: true });
      throw error;
    }
  }
  const profileFolder = await newPrivateTempFolder(`ogw-${role}-sandbox-`, ctx.env);
  try {
    const writes = allowedWrites(ctx.env, folder);
    const agentFolders = otherAgentFolders(ctx.env, folder);
    const blocked = await agentBlocked(ws, ctx.env, writes, agentFolders, cliLog, socket);
    makeBlocked(blocked);
    const profileFile = join(profileFolder, 'sandbox.sb');
    await writeFile(profileFile, macosProfile(blocked));
    let brokerCommand: CliToRun['brokerCommand'] = null;
    let brokerWorker: CliToRun['brokerWorker'] = null;
    if (socket !== null) {
      const forBroker = await brokerBlocked(ws, ctx.env, writes, agentFolders);
      makeBlocked(forBroker);
      const brokerProfile = join(profileFolder, 'broker.sb');
      await writeFile(brokerProfile, macosProfile(forBroker));
      const inBroker = (args: readonly string[]): CliCommand =>
        sandboxed({ cmd: process.execPath, args: [...process.execArgv, cliEntry(), ...args] }, forBroker, {
          macosProfileFile: brokerProfile,
          pidNamespace: false,
        });
      brokerCommand = (argv) => inBroker([BROKER_RUN, ...argv]);
      brokerWorker = inBroker([BROKER_WORKER]);
    }
    const wrap = (cli: CliCommand): CliCommand => sandboxed(withoutSessionFiles(agentCli(agent), cli), blocked, { macosProfileFile: profileFile });
    return {
      command: wrap(command),
      wrap,
      env: { ...withOgwOnPath(agentEnv(ctx.env, folder)), ...loginTokenEnv(ctx, agent), ...(socket === null ? {} : { [BROKER_ENV]: socket }) },
      profileFolder,
      brokerCommand,
      brokerWorker,
    };
  } catch (error) {
    await rm(profileFolder, { recursive: true, force: true });
    throw error;
  }
}

/** Runs agent CLI `command` with `cli.env` once, its output appended to `logPath`. */
async function runCli(
  id: string,
  ctx: Context,
  meta: AgentMeta,
  cli: CliToRun,
  command: CliCommand,
  prompt: string,
  logPath: string,
  key: string,
): Promise<CliRun> {
  const log = openSync(logPath, 'a');
  const child = spawnTracked(command.cmd, command.args, {
    cwd: meta.folder ?? undefined,
    env: childEnv(cli.env, key),
    stdio: ['pipe', log, log],
  });
  closeSync(log);
  const ended = new Promise<CliRun>((resolvePromise) => {
    child.on('error', (error) => {
      resolvePromise({ code: null, error: `cannot run ${command.cmd}: ${error.message}` });
    });
    child.on('exit', (code) => {
      resolvePromise({ code, error: null });
    });
  });
  const stop = (): void => {
    killTree(child, 'SIGTERM');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(prompt);
    const pid = child.pid;
    if (pid !== undefined) {
      await changeAgentMeta(id, ctx.env, (m) => {
        m.cliPid = pid;
        m.cliPidStartedAt = processStartedAt(pid);
      });
    }
    return await ended;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    killTree(child, 'SIGKILL');
  }
}

/**
 * Commits `paths` in the checkout that holds `dir`, if any, under the agent commit lock of that checkout, so the
 * commits of `ogw agent` jobs and retries in the same checkout never run at once.
 */
export async function commitInCheckout(
  dir: string,
  paths: readonly string[],
  message: string,
  options: { env: NodeJS.ProcessEnv; noVerify: boolean },
): Promise<void> {
  const top = await gitLine(dir, ['rev-parse', '--show-toplevel'], { env: options.env }).catch(() => null);
  if (top === null) return;
  // the folder resolved, the name not: a symlink is committed as itself, never the path it points to
  const inside = paths.filter((path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined).map((path) => relative(top, join(realpathSync(dirname(path)), basename(path))));
  if (inside.length === 0) return;
  await withLock(join(await gitDir(top, { env: options.env }), 'ogw-agent-commit.lock'), async () => {
    await commitPaths(top, inside, message, options);
  });
}

/** Whether `path` is there as something other than a regular file (a symlink, a folder): the agent replaced it. */
function notRegularFile(path: string): boolean {
  const info = lstatSync(path, { throwIfNoEntry: false });
  return info !== undefined && !info.isFile();
}

/**
 * `text` with each path into the agent folder `captures` changed to its path in `evidence`: absolute, or relative as
 * `captures/` or `./captures/`. One pass, so that it does not scan the paths it writes.
 */
export function movedCapturePaths(text: string, captures: string, evidence: string): string {
  const path = new RegExp(`${escapeRegExp(captures)}|(?<![\\p{L}\\p{N}_./\\\\-])(?:\\./)?captures/`, 'gu');
  return text.replace(path, (match) => (match === captures ? evidence : `${evidence}/`));
}

/**
 * play, judge: moves the result file and `captures/` out of the agent folder, then removes the folder. A result file
 * that is not a regular file stays behind and fails the agent (`problem`).
 */
async function finishTemp(id: string, ctx: Context, meta: AgentMeta): Promise<{ meta: AgentMeta; problem: string | null }> {
  if (meta.place.kind !== 'temp' || meta.output === undefined || meta.finalOutput === null || meta.evidence === null) return { meta, problem: null };
  const folder = meta.place.dir;
  const captures = join(folder, 'captures');
  const problem = notRegularFile(meta.output) ? 'the result file is not a regular file' : null;
  if (problem === null && exists(meta.output)) {
    const text = await readFile(meta.output, 'utf8');
    const rewritten = movedCapturePaths(text, captures, meta.evidence);
    await writeFileAtomic(meta.finalOutput, rewritten);
  }
  if (exists(captures)) await move(captures, meta.evidence);
  await rm(folder, { recursive: true, force: true });
  const finalOutput = meta.finalOutput;
  await changeAgentMeta(id, ctx.env, (m) => {
    m.output = finalOutput;
  });
  return { meta: { ...meta, output: finalOutput }, problem };
}

async function addTranslationCounts(meta: AgentMeta, env: NodeJS.ProcessEnv): Promise<void> {
  if (meta.role !== 'translation' || meta.worktree === null || meta.place.kind !== 'game-worktree' || meta.runLog === undefined) return;
  const before = await readTranslationFiles(meta.worktree, meta.place.baseCommit, { env });
  const after = await readTranslationFiles(meta.worktree, await head(meta.worktree, { env }), { env });
  await addRunLogFields(meta.runLog, { translation: translationCounts(before, after) });
}

/**
 * Moves, commits and removes what the agent left. `meta` is the one this job process set before the agent CLI
 * started; the job record is not read back, so what the agent wrote there cannot choose what is committed or removed.
 * `problem` is why the agent fails although it ended well (`finishTemp`).
 */
async function finish(id: string, ctx: Context, meta: AgentMeta): Promise<{ meta: AgentMeta; problem: string | null }> {
  const moved = await finishTemp(id, ctx, meta);
  let current = moved.meta;
  await addTranslationCounts(current, ctx.env);
  // In a core worktree the result file (core report, core review file) is committed so that it is on main after
  // `ogw agent merge` removes the worktree. The pre-commit hook of core worktrees is for the agent's own commits.
  if (current.place.kind === 'core-worktree') {
    const output = current.output as string;
    await commitInCheckout(dirname(output), [output], `ogw agent ${id}: result file`, { env: ctx.env, noVerify: true });
  }
  if (current.place.kind === 'tool-worktree' && current.worktree !== null) {
    await removeToolWorktree(current.place.harness, current.worktree, ctx.env);
    await changeAgentMeta(id, ctx.env, (m) => {
      m.worktree = null;
    });
    current = { ...current, worktree: null };
  }
  return { meta: current, problem: moved.problem };
}

async function tail(path: string, lines: number): Promise<string> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.split('\n').slice(-lines - 1).join('\n').trimEnd();
}

const LOG_TAIL_LINES = 100;

/** Modification time and content hash of a file, or null when it does not exist. */
async function fileStamp(path: string): Promise<string | null> {
  if (!exists(path)) return null;
  const [info, data] = await Promise.all([stat(path), readFile(path)]);
  return `${String(info.mtimeMs)} ${createHash('sha256').update(data).digest('hex')}`;
}

/**
 * Whether the agent wrote its result file: it exists and is not the file that was at that path before the agent CLI
 * started (an earlier attempt's result of the same name, for example the content report of a retry in one iteration).
 */
async function wroteOutput(output: string, before: string | null): Promise<boolean> {
  if (notRegularFile(output)) return false;
  const after = await fileStamp(output);
  return after !== null && after !== before;
}

/**
 * The environment of this job once the agent CLI has ended: git reads no global or system config (a sandboxed
 * agent may have written `~/.gitconfig`), runs no fsmonitor and no hook of any config, and commits as the author and
 * committer git chose, before the agent CLI started, where the result file goes.
 */
async function afterCliEnv(env: NodeJS.ProcessEnv, meta: AgentMeta): Promise<NodeJS.ProcessEnv> {
  const output = meta.finalOutput ?? meta.output;
  const identity = output === undefined ? {} : await gitIdentity(dirname(output), { env });
  return withGitConfig({ ...env, ...identity, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, [
    ['core.fsmonitor', 'false'],
    ['core.hooksPath', '/dev/null'],
  ]);
}

/** Runs one agent CLI command with its prompt, as a run of the job (`runWithBroker`). */
type RunOnce = (command: CliCommand, prompt: string) => Promise<CliRun>;

/**
 * Runs the runs of the agent CLI that `work` makes with one new agent key. For play and judge the broker serves the
 * CLI's `ogw` calls while they run; when they end, the broker closes and the jobs the agent started end with it. From
 * then on `ctx.env` is `run.afterEnv`, for every later git call of this job process.
 */
async function runWithBroker<T>(
  id: string,
  ctx: Context,
  meta: AgentMeta,
  toRun: CliToRun,
  run: { logPath: string; socket: string | null; runLog: string; afterEnv: NodeJS.ProcessEnv },
  work: (runOnce: RunOnce) => Promise<T>,
): Promise<T> {
  const key = newAgentKey(id);
  await changeAgentMeta(id, ctx.env, (m) => {
    m.keyHash = key.hash;
  });
  await markAgentRunning(id, ctx.env);
  let broker: Broker | null = null;
  try {
    if (run.socket !== null && toRun.brokerCommand !== null) {
      // the forwarded commands run as this agent: its environment outside the sandbox, with its key
      broker = await startBroker({ socket: run.socket, key: key.value, command: toRun.brokerCommand, worker: toRun.brokerWorker ?? undefined, env: childEnv(agentEnv(ctx.env, meta.folder), key.value) });
    }
    return await work((command, prompt) => runCli(id, ctx, meta, toRun, command, prompt, run.logPath, key.value));
  } finally {
    ctx.env = run.afterEnv;
    await agentCliEnded(id, ctx.env, run.runLog);
    // a job or instance the agent left running holds the host (and an instance slot) until someone ends it; the jobs
    // first, so a waiting `instance start` does not start one after the list
    await endJobsOfAgent(id, ctx.env).catch(() => undefined);
    await stopInstancesOfAgent(ctx, id).catch(() => undefined);
    if (broker !== null) await broker.close().catch(() => undefined);
    if (toRun.profileFolder !== null) await rm(toRun.profileFolder, { recursive: true, force: true });
  }
}

/** The background job of `ogw agent`: runs the agent CLI and handles its result. */
export async function runAgentJob(ctx: Context): Promise<CommandResult> {
  const id = ctx.jobId;
  if (id === null) throw new OgwError('agent __run runs only as an ogw agent job');
  let meta = (await readAgentJob(id, ctx.env)).meta;
  try {
    meta = await makePlace(id, ctx, meta);
    return await runPlacedAgent(id, ctx, meta);
  } catch (error) {
    await removeTempPlace(ctx, meta);
    throw error;
  }
}

/** `runAgentJob` once the agent's folder is made. */
async function runPlacedAgent(id: string, ctx: Context, meta: AgentMeta): Promise<CommandResult> {
  if (meta.output === undefined || meta.runLog === undefined) throw new OgwError('agent result file path is not set');
  if (!exists(meta.runLog)) await writeJsonAtomic(meta.runLog, { runs: [] });
  // the folder of the result file is there before the agent writes the file
  await mkdir(dirname(meta.output), { recursive: true });
  const settings = await jobHarnessSettings(ctx, meta);
  const ws = await ctx.workspace();
  const prompt = await buildPrompt(ws.harness, meta.role, { input: meta.agentInput, output: meta.output, run: meta.run, iteration: meta.iteration });
  const logPath = await agentCliLog(id, ctx.env);
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, '');
  const socket = SANDBOXED_ROLES.includes(meta.role) ? await brokerSocket(id, ctx.env) : null;
  // the sandbox blocks the secret store, not the old store a value may still be in
  if (SANDBOXED_ROLES.includes(meta.role)) await moveOldSecrets(ctx);
  const before = await fileStamp(meta.output);
  const afterEnv = await afterCliEnv(ctx.env, meta);
  // `runWithBroker` removes the sandbox profile folder this makes
  const agent = jobAgentSettings(meta, () => agentSettings(settings, meta.role));
  const toRun = await cliToRun(ctx, meta.role, agent, ws, logPath, socket, meta.folder, meta.game);
  if (!SANDBOXED_ROLES.includes(meta.role)) toRun.command = toRun.wrap(firstRunCommand(agent, meta.session ?? null));
  const output = meta.output;
  const keepSession = async (session: AgentSession): Promise<void> => {
    await changeAgentMeta(id, ctx.env, (m) => {
      m.session = session;
    });
  };
  const rounds = await runWithBroker(id, ctx, meta, toRun, { logPath, socket, runLog: meta.runLog, afterEnv }, (runOnce) =>
    runRounds(meta, { agent, toRun, logPath, output, before, limit: settings.resultFixRounds, prompt, keepSession }, runOnce),
  );
  await recordUsage(id, ctx, rounds.session, agent, await runLogs(logPath, rounds.starts), meta.runLog);
  const written = await wroteOutput(output, before);
  await changeAgentMeta(id, ctx.env, (m) => {
    m.outputWritten = written;
  });
  const finished = await finish(id, ctx, meta);
  const result = finished.meta.output;
  return jobResult(rounds.cli, written && result !== undefined && exists(result) ? result : null, finished.problem ?? formatProblem(rounds.errors), logPath, agentCli(agent));
}

/**
 * What the runs of the agent CLI of a job ended with: the last run, where each run's output starts in the CLI log, the
 * format errors left, and the session of the job.
 */
interface Rounds {
  cli: CliRun;
  /** The byte offset in `<id>.cli.log` where the output of each run starts, in run order. */
  starts: number[];
  errors: string[];
  session: AgentSession | null;
}

/** The reason a job fails for the format errors left in its result file (ogw.md `### result format`), or null for none. */
function formatProblem(errors: readonly string[]): string | null {
  return errors.length === 0 ? null : `result file: ${errors.join('; ')}`;
}

/**
 * The session of the job once its first run has ended (ogw.md `## agent`): the one it started with, or for a new Codex
 * session of a role with fix rounds the `thread_id` its first run printed, kept in the job record. null without one.
 */
async function jobSession(meta: AgentMeta, agent: AgentSettings, firstRun: string, keep: (session: AgentSession) => Promise<void>): Promise<AgentSession | null> {
  const started = meta.session ?? null;
  if (started !== null || !FIX_ROUND_ROLES.includes(meta.role) || agentCli(agent) !== 'codex') return started;
  const thread = codexThreadId(firstRun);
  if (thread === null) return null;
  const session = { id: thread, resume: false };
  await keep(session);
  return session;
}

/**
 * The first run of the agent CLI, then the fix rounds of its result file (ogw.md `### result format` of `## agent`):
 * while a run ends with exit code 0 and a result file the agent wrote that has format errors, at most `limit` rounds
 * continue the session of the job with the prompt that lists them.
 */
async function runRounds(
  meta: AgentMeta,
  job: {
    agent: AgentSettings;
    toRun: CliToRun;
    logPath: string;
    output: string;
    before: string | null;
    limit: number;
    prompt: string;
    keepSession: (session: AgentSession) => Promise<void>;
  },
  runOnce: RunOnce,
): Promise<Rounds> {
  const starts = [0];
  let cli = await runOnce(job.toRun.command, job.prompt);
  const session = await jobSession(meta, job.agent, (await runLogs(job.logPath, starts))[0] ?? '', job.keepSession);
  for (let round = 0; ; round++) {
    if (cli.code !== 0 || cli.error !== null || !(await wroteOutput(job.output, job.before))) return { cli, starts, errors: [], session };
    const errors = await resultFormatErrors(meta, job.output).catch((error: unknown) => [`cannot be read: ${error instanceof Error ? error.message : String(error)}`]);
    if (errors.length === 0 || round >= job.limit || session === null || !FIX_ROUND_ROLES.includes(meta.role)) return { cli, starts, errors, session };
    starts.push((await stat(job.logPath)).size);
    cli = await runOnce(job.toRun.wrap(agentResumeCommand(job.agent, session.id)), fixRoundPrompt(job.output, errors));
  }
}

/** The output of each run in the CLI log, the runs starting at the byte offsets `starts`. */
async function runLogs(logPath: string, starts: readonly number[]): Promise<string[]> {
  const log = await readFile(logPath).catch(() => Buffer.alloc(0));
  return starts.map((start, i) => log.subarray(start, starts[i + 1] ?? log.length).toString('utf8'));
}

/** The `sessionUsage` of the job of session `session` that started last before job `id`; null without one. */
async function earlierSessionUsage(id: string, session: string, env: NodeJS.ProcessEnv): Promise<SessionUsage | null> {
  const jobs = (await listJobs(env)).filter((job) => job.command === 'agent');
  const startedAt = jobs.find((job) => job.id === id)?.startedAt ?? Number.POSITIVE_INFINITY;
  const earlier = jobs
    .filter((job) => job.id !== id && job.startedAt <= startedAt && (job.meta.session as AgentSession | null | undefined)?.id === session)
    .sort((a, b) => a.startedAt - b.startedAt)
    .at(-1);
  return (earlier?.meta.sessionUsage as SessionUsage | undefined) ?? null;
}

/**
 * Reads the usage the runs of the agent CLI printed, `logs` holding the output of each run, and writes it as `usage` in
 * the job record and the run log (ogw.md `### usage` of `## agent`), with the usage line of the session of the job as
 * `sessionUsage`. A last run that printed none leaves the values null; the job does not fail for it.
 */
async function recordUsage(id: string, ctx: Context, session: AgentSession | null, agent: AgentSettings, logs: readonly string[], runLog: string): Promise<void> {
  const cli = agentCli(agent);
  const printed = runsUsage(cli, logs);
  const before = session?.resume === true ? await earlierSessionUsage(id, session.id, ctx.env) : null;
  const usage = jobUsage(agent, printed, session?.resume === true, before);
  await changeAgentMeta(id, ctx.env, (m) => {
    m.usage = usage;
    if (session !== null && printed !== null) m.sessionUsage = sessionUsageOf(printed);
  });
  await addRunLogFields(runLog, { usage });
}

/**
 * The result of the job: the result file, or why the agent failed with the tail of its CLI log, in which a Claude Code
 * result object is shown as its `result` text.
 */
async function jobResult(cli: CliRun, result: string | null, problem: string | null, logPath: string, agent: AgentCli): Promise<CommandResult> {
  if (cli.code === 0 && cli.error === null && result !== null && problem === null) return { text: result, data: { output: result } };
  const reason = cli.error ?? (cli.code !== 0 ? `agent CLI ended with code ${String(cli.code)}` : (problem ?? 'the agent left no result file'));
  const tailed = await tail(logPath, LOG_TAIL_LINES);
  const log = agent === 'claude-code' ? withResultText(tailed) : tailed;
  return { exitCode: 1, text: [`failed: ${reason}`, `output: ${result ?? 'none'}`, log].filter((line) => line !== '').join('\n'), data: { reason, output: result } };
}
