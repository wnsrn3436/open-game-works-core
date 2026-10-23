import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
import { addRunLogFields, agentCliEnded, markAgentRunning, newAgentKey, runLogPath } from '../../../lib/agentctx.ts';
import type { CommandResult, Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { exists, writeFileAtomic, writeJsonAtomic } from '../../../lib/fsx.ts';
import { BROKER_ENV, BROKER_RUN } from '../../../lib/broker-client.ts';
import { commitPaths, commonDir, gitDir, gitIdentity, gitLine, head, withGitConfig, worktreeAdd, worktreeRemove } from '../../../lib/git.ts';
import { AGENT_KEY_ENV, endJobsOfAgent, jobsDir } from '../../../lib/jobs.ts';
import { withLock } from '../../../lib/lock.ts';
import { escapeRegExp } from '../../../lib/regexp.ts';
import { cliEntry } from '../../../lib/paths.ts';
import { newPrivateTempFolder, privateTempDir, secretFilesDir } from '../../../lib/secret-files.ts';
import { secretStoreFolders } from '../../../lib/secrets.ts';
import { moveOldSecrets } from '../../secret/lib/move.ts';
import { storedLoginToken } from '../../secret/lib/login-token.ts';
import type { AgentSettings, Workspace } from '../../../lib/settings.ts';
import { killTree, processStartedAt, spawnTracked } from '../../../lib/proc.ts';
import { startBroker, type Broker } from './broker.ts';
import {
  agentCli,
  agentCliCommand,
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
  type Blocked,
  type CliCommand,
} from './cli-command.ts';
import { AGENT_TEMP_FOLDER, agentFolderPrefix, move, osTempFolder } from './files.ts';
import { AGENT_LOG_FOLDER, agentCliLog, changeAgentMeta, readAgentJob, type AgentMeta } from './meta.ts';
import { buildPrompt } from './prompt.ts';
import { instancesDir } from '../../instance/lib/records.ts';
import { stopInstancesOfAgent } from '../../instance/api.ts';
import { readTranslationFiles } from './translation-files.ts';
import { translationCounts } from './rowmerge.ts';

/** The pre-commit hook command core worktrees need. */
export const PRE_COMMIT_COMMAND = 'meta sync core --staged';

/** Installs a pre-commit hook running `ogw meta sync core --staged` in the repo's hook folder when there is none. */
export async function ensurePreCommitHook(repo: string): Promise<void> {
  const hooks = resolve(repo, await gitLine(repo, ['rev-parse', '--git-path', 'hooks']));
  const hook = join(hooks, 'pre-commit');
  const line = `"${process.execPath}" "${cliEntry()}" ${PRE_COMMIT_COMMAND}`;
  if (exists(hook)) {
    const current = await readFile(hook, 'utf8');
    if (current.includes(PRE_COMMIT_COMMAND)) return;
    const [first, ...rest] = current.split('\n');
    const text = first?.startsWith('#!') ? [first, `${line} || exit 1`, ...rest].join('\n') : `${line} || exit 1\n${current}`;
    await writeFileAtomic(hook, text);
  } else {
    await writeFileAtomic(hook, `#!/bin/sh\nexec ${line}\n`);
  }
  await chmod(hook, 0o755);
}

/** Makes the agent's worktree and sets the folder and result file path in the job meta. */
async function makePlace(id: string, ctx: Context, meta: AgentMeta): Promise<AgentMeta> {
  const place = meta.place;
  let worktree: string | null = null;
  if (place.kind === 'game-worktree') {
    worktree = join(place.worktrees, meta.game as string, `agent-${id}`);
    await worktreeAdd(place.checkout, worktree, place.baseCommit, `agent/${id}`, { env: ctx.env });
  } else if (place.kind === 'core-worktree') {
    await ensurePreCommitHook(place.coreImpl);
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
      if (m.output !== undefined) m.runLog = runLogPath(m.output);
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
export type SandboxWorkspace = Pick<Workspace, 'harness' | 'coreImpl' | 'coreReleases' | 'games' | 'worktrees'>;

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

/** The environment with the harness `tools/bin` first on `PATH`, so the agent's shell finds `ogw` by name. */
export function withOgwOnPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bin = resolve(dirname(cliEntry()), '..', 'bin');
  const rest = (env.PATH ?? '').split(delimiter).filter((dir) => dir !== '' && dir !== bin);
  return { ...env, PATH: [bin, ...rest].join(delimiter) };
}

/** The roles whose agent CLI `ogw agent` runs in the OS sandbox. */
export const SANDBOXED_ROLES: readonly string[] = ['play', 'judge'];

export interface CliToRun {
  command: CliCommand;
  /** The environment the command runs with. */
  env: NodeJS.ProcessEnv;
  /** play, judge: folder with the sandbox profiles in the temp folder of ogw; the caller removes it. */
  profileFolder: string | null;
  /** play, judge with a broker: the command that runs a forwarded argv in the broker sandbox. */
  brokerCommand: ((argv: readonly string[]) => CliCommand) | null;
}

/**
 * The agent CLI command of `ogw agent` and `ogw env check`; for play and judge in the agent sandbox, with the
 * default config folder (the user's login) and no session file of its own. `cliLog` is the file the CLI output goes
 * to when it is under the agent log folder (`ogw agent`), else null. `socket` is the broker socket (`ogw agent`),
 * else null. `folder` is the folder the agent starts in (`ogw agent`, the play and judge run of `ogw env check`), whose
 * `tmp/` the CLI gets as `TMPDIR`, else null.
 */
export async function cliToRun(
  ctx: Context,
  role: string,
  agent: AgentSettings,
  ws: SandboxWorkspace,
  cliLog: string | null,
  socket: string | null = null,
  folder: string | null = null,
): Promise<CliToRun> {
  const command = agentCliCommand(agent);
  if (!SANDBOXED_ROLES.includes(role)) return { command, env: withOgwOnPath(ctx.env), profileFolder: null, brokerCommand: null };
  const profileFolder = await newPrivateTempFolder(`ogw-${role}-sandbox-`, ctx.env);
  try {
    const writes = allowedWrites(ctx.env, folder);
    const agentFolders = otherAgentFolders(ctx.env, folder);
    const blocked = await agentBlocked(ws, ctx.env, writes, agentFolders, cliLog, socket);
    makeBlocked(blocked);
    const profileFile = join(profileFolder, 'sandbox.sb');
    await writeFile(profileFile, macosProfile(blocked));
    let brokerCommand: CliToRun['brokerCommand'] = null;
    if (socket !== null) {
      const forBroker = await brokerBlocked(ws, ctx.env, writes, agentFolders);
      makeBlocked(forBroker);
      const brokerProfile = join(profileFolder, 'broker.sb');
      await writeFile(brokerProfile, macosProfile(forBroker));
      brokerCommand = (argv) =>
        sandboxed({ cmd: process.execPath, args: [...process.execArgv, cliEntry(), BROKER_RUN, ...argv] }, forBroker, {
          macosProfileFile: brokerProfile,
          pidNamespace: false,
        });
    }
    return {
      command: sandboxed(withoutSessionFiles(agentCli(agent), command), blocked, { macosProfileFile: profileFile }),
      env: { ...withOgwOnPath(agentEnv(ctx.env, folder)), ...loginTokenEnv(ctx, agent), ...(socket === null ? {} : { [BROKER_ENV]: socket }) },
      profileFolder,
      brokerCommand,
    };
  } catch (error) {
    await rm(profileFolder, { recursive: true, force: true });
    throw error;
  }
}

async function runCli(
  id: string,
  ctx: Context,
  meta: AgentMeta,
  cli: CliToRun,
  prompt: string,
  logPath: string,
  key: string,
): Promise<CliRun> {
  const { command } = cli;
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
 * play, judge: moves the result file, `captures/` and the run log out of the agent folder, then removes the folder.
 * A result file or run log that is not a regular file stays behind and fails the agent (`problem`).
 */
async function finishTemp(id: string, ctx: Context, meta: AgentMeta): Promise<{ meta: AgentMeta; problem: string | null }> {
  if (meta.place.kind !== 'temp' || meta.output === undefined || meta.finalOutput === null || meta.evidence === null) return { meta, problem: null };
  const folder = meta.place.dir;
  const captures = join(folder, 'captures');
  const problems: string[] = [];
  if (notRegularFile(meta.output)) problems.push('the result file is not a regular file');
  else if (exists(meta.output)) {
    const text = await readFile(meta.output, 'utf8');
    const rewritten = text.replace(new RegExp(escapeRegExp(captures), 'g'), meta.evidence);
    await writeFileAtomic(meta.finalOutput, rewritten);
  }
  if (exists(captures)) await move(captures, meta.evidence);
  const finalRunLog = runLogPath(meta.finalOutput);
  if (meta.runLog !== undefined && notRegularFile(meta.runLog)) problems.push('the run log is not a regular file');
  else if (meta.runLog !== undefined && exists(meta.runLog)) await move(meta.runLog, finalRunLog);
  await rm(folder, { recursive: true, force: true });
  const finalOutput = meta.finalOutput;
  await changeAgentMeta(id, ctx.env, (m) => {
    m.output = finalOutput;
    m.runLog = finalRunLog;
  });
  return { meta: { ...meta, output: finalOutput, runLog: finalRunLog }, problem: problems.length === 0 ? null : problems.join('; ') };
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
  const output = current.output as string;
  const runLog = current.runLog as string;
  // records only: the pre-commit hook of core worktrees is for the agent's own commits
  const records = { env: ctx.env, noVerify: true };
  // In a core worktree the result file (core report, core review file) is committed so that it is on main after
  // `ogw agent merge` removes the worktree.
  if (current.place.kind === 'core-worktree') {
    await commitInCheckout(dirname(output), [output], `ogw agent ${id}: result file`, records);
  }
  await commitInCheckout(dirname(runLog), [runLog], `ogw agent ${id}: run log`, records);
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

/**
 * Runs the agent CLI with a new agent key. For play and judge the broker serves the CLI's `ogw` calls while it
 * runs; when it ends, the broker closes and the jobs the agent started end with it. From then on `ctx.env` is
 * `run.afterEnv`, for every later git call of this job process.
 */
async function runWithBroker(
  id: string,
  ctx: Context,
  meta: AgentMeta,
  toRun: CliToRun,
  run: { prompt: string; logPath: string; socket: string | null; runLog: string; afterEnv: NodeJS.ProcessEnv },
): Promise<CliRun> {
  const key = newAgentKey(id);
  await changeAgentMeta(id, ctx.env, (m) => {
    m.keyHash = key.hash;
  });
  await markAgentRunning(id, ctx.env);
  let broker: Broker | null = null;
  try {
    if (run.socket !== null && toRun.brokerCommand !== null) {
      // the forwarded commands run as this agent: its environment outside the sandbox, with its key
      broker = await startBroker({ socket: run.socket, key: key.value, command: toRun.brokerCommand, env: childEnv(agentEnv(ctx.env, meta.folder), key.value) });
    }
    return await runCli(id, ctx, meta, toRun, run.prompt, run.logPath, key.value);
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
  const settings = await ctx.settings();
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
  const toRun = await cliToRun(ctx, meta.role, agentSettings(settings, meta.role), ws, logPath, socket, meta.folder);
  const cli = await runWithBroker(id, ctx, meta, toRun, { prompt, logPath, socket, runLog: meta.runLog, afterEnv });
  const written = await wroteOutput(meta.output, before);
  await changeAgentMeta(id, ctx.env, (m) => {
    m.outputWritten = written;
  });
  const finished = await finish(id, ctx, meta);
  const output = finished.meta.output;
  return jobResult(cli, written && output !== undefined && exists(output) ? output : null, finished.problem, logPath);
}

/** The result of the job: the result file, or why the agent failed with the tail of its CLI log. */
async function jobResult(cli: CliRun, result: string | null, problem: string | null, logPath: string): Promise<CommandResult> {
  if (cli.code === 0 && cli.error === null && result !== null && problem === null) return { text: result, data: { output: result } };
  const reason = cli.error ?? (cli.code !== 0 ? `agent CLI ended with code ${String(cli.code)}` : (problem ?? 'the agent left no result file'));
  const log = await tail(logPath, LOG_TAIL_LINES);
  return { exitCode: 1, text: [`failed: ${reason}`, `output: ${result ?? 'none'}`, log].filter((line) => line !== '').join('\n'), data: { reason, output: result } };
}
