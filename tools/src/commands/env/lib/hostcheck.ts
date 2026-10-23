import type { ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { lstat, rm, statfs } from 'node:fs/promises';
import { cpus, homedir, networkInterfaces, release, totalmem, type } from 'node:os';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { isNotFound } from '../../../lib/fsx.ts';
import { isPlainObject, type JsonObject } from '../../../lib/json.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { killTree, run, spawnTracked } from '../../../lib/proc.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';
import type { AgentSettings, HarnessSettings, Role } from '../../../lib/settings.ts';
import { agentCli } from '../../agent/lib/cli-command.ts';
import { newAgentFolder } from '../../agent/lib/files.ts';
import { cliToRun, SANDBOXED_ROLES, type CliToRun } from '../../agent/lib/launch.ts';
import { loginTokenRoles } from '../../secret/lib/login-token.ts';
import { probeBuildTool } from '../api.ts';
import type { EngineSource } from './engines.ts';
import { whichIn, type HostPlatform } from './host.ts';
import { dockerBuildx, probeProgram } from './probe.ts';
import type { AgentCliCheck, BuildToolCheck, EnvCheckResult, ProgramCheck, ProviderCliCheck, TokenCheck } from './results.ts';


/** Time limit of the short prompt each agent CLI runs. */
export const AGENT_PROBE_MS = 5 * 60_000;
let agentProbeMs = AGENT_PROBE_MS;

/** Replaces the prompt run time limit for tests; null puts `AGENT_PROBE_MS` back. */
export function setAgentProbeMs(ms: number | null): void {
  agentProbeMs = ms ?? AGENT_PROBE_MS;
}
/** How long the host waits for the UDP datagram an android device sends. */
export const UDP_WAIT_MS = 5000;
let udpWaitMs = UDP_WAIT_MS;

/** Replaces the UDP wait for tests; null puts `UDP_WAIT_MS` back. */
export function setUdpWaitMs(ms: number | null): void {
  udpWaitMs = ms ?? UDP_WAIT_MS;
}
export const AGENT_PROBE_PROMPT = 'Reply with the single word ok.';

const OUTPUT_MAX = 2000;

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_MAX ? trimmed.slice(trimmed.length - OUTPUT_MAX) : trimmed;
}

export async function hostInfo(ctx: Context, platform: HostPlatform | null): Promise<EnvCheckResult['host']> {
  const list = cpus();
  const disk = await statfs((await ctx.workspace()).root).catch(() => null);
  return {
    platform,
    os: `${type()} ${release()}`,
    cpu: { model: list[0]?.model ?? '', count: list.length },
    memoryBytes: totalmem(),
    freeDiskBytes: disk ? disk.bavail * disk.bsize : null,
  };
}

export async function programChecks(env: NodeJS.ProcessEnv): Promise<Record<string, ProgramCheck>> {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const [git, node, uv, py, docker, buildx, gh] = await Promise.all([
    probeProgram(env, 'git', ['--version']),
    probeProgram(env, 'node', ['--version']),
    probeProgram(env, 'uv', ['--version']),
    probeProgram(env, python, ['--version']),
    probeProgram(env, 'docker', ['--version']),
    dockerBuildx(env),
    probeProgram(env, 'gh', ['--version']),
  ]);
  return { git, node, uv, python: py, docker, dockerBuildx: buildx, gh };
}

export interface CliDef {
  program: string;
  /** Login check: exit code 0 means logged in. null: no defined check. */
  login: string[] | null;
}

export const CLI_DEFS: Record<string, CliDef> = {
  'claude-code': { program: 'claude', login: ['auth', 'status'] },
  codex: { program: 'codex', login: ['login', 'status'] },
  grok: { program: 'grok', login: null },
};

async function loginState(env: NodeJS.ProcessEnv, def: CliDef): Promise<Pick<CliState, 'loggedIn' | 'loginOutput'>> {
  if (def.login === null) return { loggedIn: null, loginOutput: '' };
  const result = await run(def.program, def.login, { env, timeoutMs: LIMITS.shortMs }).catch(() => null);
  return { loggedIn: result !== null && result.code === 0, loginOutput: result === null ? '' : `${result.stdout}\n${result.stderr}` };
}

interface PromptRun {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Runs the short prompt, on stdin, with the command and env `ogw agent` runs for that agent settings and role:
 * for play and judge in the OS sandbox, whose profile folder is removed after the run. `extra` adds arguments to the
 * end of the command and sets environment variables.
 */
async function promptRun(ctx: Context, agent: AgentSettings, role: string, extra: { args: string[]; env: NodeJS.ProcessEnv } = { args: [], env: {} }): Promise<PromptRun> {
  // a sandboxed CLI starts in an agent folder like play and judge; a CLI outside the sandbox starts in the temp folder
  // of ogw, where no sandboxed agent plants config
  const sandboxed = SANDBOXED_ROLES.includes(role);
  const dir = sandboxed ? await newAgentFolder(role, ctx.env) : await newPrivateTempFolder('ogw-agent-probe-', ctx.env);
  let cli: CliToRun;
  try {
    cli = await cliToRun(ctx, role, agent, await ctx.workspace(), null, null, sandboxed ? dir : null);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    return { code: null, timedOut: false, stdout: '', stderr: (error as Error).message };
  }
  const { command, env, profileFolder } = cli;
  try {
    return await run(command.cmd, [...command.args, ...extra.args], { cwd: dir, env: { ...env, ...extra.env }, input: AGENT_PROBE_PROMPT, timeoutMs: agentProbeMs }).catch(
      (error: unknown) => ({ code: null, timedOut: false, stdout: '', stderr: (error as Error).message }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (profileFolder !== null) await rm(profileFolder, { recursive: true, force: true });
  }
}

async function probeRun(ctx: Context, agent: AgentSettings, role: string): Promise<NonNullable<AgentCliCheck['run']>> {
  const result = await promptRun(ctx, agent, role);
  const ok = result.code === 0 && !result.timedOut;
  const output = result.timedOut ? `timed out after ${String(agentProbeMs)} ms` : tail(ok ? result.stdout : `${result.stderr}\n${result.stdout}`);
  return { ok, exitCode: result.code, output };
}

/** Claude Code arguments of the token check run: one JSON message per stdout line. */
export const TOKEN_CHECK_ARGS: readonly string[] = ['--output-format', 'stream-json', '--verbose'];

function jsonLines(stdout: string): JsonObject[] {
  return stdout.split('\n').flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return isPlainObject(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

/**
 * The token check run (`tools/ogw.md` `## secret set`): the `ogw env check` prompt run of the first play or judge
 * role whose agent CLI is Claude Code, with `CLAUDE_CODE_OAUTH_TOKEN` set to `token` and stream-json output. Null when
 * neither role uses Claude Code.
 */
export async function tokenCheckRun(ctx: Context, settings: HarnessSettings, token: string): Promise<TokenCheck | null> {
  const role = loginTokenRoles(settings)[0];
  if (role === undefined) return null;
  const agent = settings.agents[role as Role] as AgentSettings;
  const result = await promptRun(ctx, agent, role, { args: [...TOKEN_CHECK_ARGS], env: { CLAUDE_CODE_OAUTH_TOKEN: token } });
  const messages = jsonLines(result.stdout);
  // Agent SDK `SDKAssistantMessage` `error`
  const authFailed = messages.some((m) => m.type === 'assistant' && m.error === 'authentication_failed');
  const ok = result.code === 0 && !result.timedOut && !authFailed;
  const resultText = messages.find((m) => m.type === 'result' && typeof m.result === 'string' && m.result.trim() !== '')?.result as string | undefined;
  const output = result.timedOut ? `timed out after ${String(agentProbeMs)} ms` : tail(resultText ?? (result.stderr.trim() !== '' ? result.stderr : result.stdout));
  return { role, ok, authFailed, exitCode: result.code, output };
}

async function installed(env: NodeJS.ProcessEnv, program: string): Promise<boolean> {
  return (await whichIn(env, program)) !== null;
}

/** A CLI installed, and logged in when installed (`false` when not installed). */
export interface CliState {
  installed: boolean;
  loggedIn: boolean | null;
  /** stdout and stderr of the login check; empty when it did not run. Kept out of the check result. */
  loginOutput: string;
}

/** The state of each CLI, checked once however many agent groups and provider methods use it. */
export type CliStates = (def: CliDef) => Promise<CliState>;

export function cliStates(env: NodeJS.ProcessEnv): CliStates {
  const clis = new Map<string, Promise<CliState>>();
  return (def) => {
    let state = clis.get(def.program);
    if (state === undefined) {
      state = installed(env, def.program).then(async (isInstalled) => ({ installed: isInstalled, ...(isInstalled ? await loginState(env, def) : { loggedIn: false, loginOutput: '' }) }));
      clis.set(def.program, state);
    }
    return state;
  };
}

/**
 * Each agent CLI, model, effort and sandbox harness settings `agents` uses: the CLI installed and logged in, and
 * the short prompt run with the `ogw agent` command of those settings. The prompts run together, each in its own
 * new folder.
 */
export async function agentCliChecks(ctx: Context, settings: HarnessSettings, cliState: CliStates = cliStates(ctx.env)): Promise<AgentCliCheck[]> {
  const groups = new Map<string, { agent: AgentSettings; sandbox: boolean; roles: string[] }>();
  for (const [role, agent] of Object.entries(settings.agents)) {
    const sandbox = SANDBOXED_ROLES.includes(role);
    const key = JSON.stringify([agentCli(agent), agent.model, agent.effort, sandbox]);
    const group = groups.get(key) ?? { agent, sandbox, roles: [] };
    group.roles.push(role);
    groups.set(key, group);
  }
  return Promise.all(
    [...groups.values()].map(async ({ agent, sandbox, roles }): Promise<AgentCliCheck> => {
      const cli = agentCli(agent);
      const def = CLI_DEFS[cli] as CliDef;
      const state = await cliState(def);
      return {
        cli,
        model: agent.model,
        effort: agent.effort,
        sandboxed: sandbox,
        roles,
        installed: state.installed,
        loggedIn: state.loggedIn,
        run: state.installed ? await probeRun(ctx, agent, roles[0] as string) : { ok: false, exitCode: null, output: `${def.program} is not installed` },
      };
    }),
  );
}

/** The login kind `codex login status` prints: `Logged in using <kind>`, with ` - <masked key>` after an API key. */
export function codexLoginKind(output: string): string | null {
  return /^Logged in using (.+?)(?: - .*)?\r?$/m.exec(output)?.[1] ?? null;
}

/** The grok login file that sprite-gen reads: `auth.json` in `GROK_HOME`, or in `~/.grok` when it is not set. null when `GROK_HOME` is set but blank, which sprite-gen refuses. */
export function grokLoginFile(env: NodeJS.ProcessEnv): string | null {
  const home = env.GROK_HOME;
  if (home === undefined) return join(env.HOME ?? homedir(), '.grok', 'auth.json');
  return home.trim() === '' ? null : join(home, 'auth.json');
}

/** The login that the provider calls of sprite-gen use, and how those calls are paid (`host-env` step 1). */
async function providerLogin(env: NodeJS.ProcessEnv, provider: string, state: CliState): Promise<Pick<ProviderCliCheck, 'loggedIn' | 'billing' | 'detail'>> {
  if (provider === 'grok') {
    const file = grokLoginFile(env);
    if (file === null) return { loggedIn: false, billing: null, detail: 'GROK_HOME is set but empty' };
    // as in sprite-gen, any entry at that path is the login, a broken one too: only its absence lets XAI_API_KEY in,
    // and a path it cannot inspect lets nothing in
    const entry = await lstat(file).then(
      () => 'present' as const,
      (error: unknown) => (isNotFound(error) ? ('absent' as const) : ('unreadable' as const)),
    );
    if (entry === 'present') return { loggedIn: true, billing: 'subscription', detail: `login file ${file}` };
    if (entry === 'unreadable') return { loggedIn: false, billing: null, detail: `cannot inspect login file ${file}` };
    const key = (env.XAI_API_KEY ?? '').trim() !== '';
    return { loggedIn: false, billing: key ? 'per-call' : null, detail: `no login file ${file}; XAI_API_KEY is ${key ? 'set' : 'not set'}` };
  }
  // codex
  if (state.loggedIn !== true) return { loggedIn: state.loggedIn, billing: null, detail: null };
  const kind = codexLoginKind(state.loginOutput);
  if (kind === null) return { loggedIn: true, billing: null, detail: 'codex login status names no login kind' };
  return { loggedIn: true, billing: kind === 'ChatGPT' ? 'subscription' : kind === 'an API key' ? 'per-call' : null, detail: `logged in using ${kind}` };
}

/** Each provider CLI harness settings `resourceGeneration` methods use: installed, logged in, and how calls are paid. */
export async function providerCliChecks(ctx: Context, settings: HarnessSettings, cliState: CliStates = cliStates(ctx.env)): Promise<ProviderCliCheck[]> {
  const methods = new Map<string, string[]>();
  for (const method of settings.resourceGeneration) {
    if (method.provider) methods.set(method.provider, [...(methods.get(method.provider) ?? []), method.name]);
  }
  return Promise.all(
    [...methods].map(async ([provider, names]): Promise<ProviderCliCheck> => {
      const state = await cliState(CLI_DEFS[provider] as CliDef);
      return { provider, methods: names, installed: state.installed, ...(await providerLogin(ctx.env, provider, state)) };
    }),
  );
}

/** Build toolchain of each game's `buildPlatforms` from its core version `engine.json` `buildTools`. */
export async function buildToolChecks(ctx: Context, sources: EngineSource[], platform: HostPlatform | null): Promise<BuildToolCheck[]> {
  const probes: Promise<BuildToolCheck>[] = [];
  for (const source of sources) {
    const buildPlatforms = source.buildPlatforms;
    if (buildPlatforms === null) continue;
    for (const tool of source.json.buildTools ?? []) {
      if (platform === null || !tool.hosts.includes(platform) || !buildPlatforms.includes(tool.platform)) continue;
      probes.push(
        probeBuildTool(ctx, tool).then((probe) => ({ from: source.from, platform: tool.platform, name: tool.name, version: tool.version, downloadable: probe.downloadable, ok: probe.ok, output: probe.output })),
      );
    }
  }
  return Promise.all(probes);
}

/** First non-internal IPv4 address of this host. */
export function lanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
}

/**
 * Opens a UDP port on the host and has `adb shell` on the device print a line and then send a datagram to it with
 * toybox `nc`, whose `-q 1` ends it 1 s after its stdin ends (without it, UDP `nc` does not end). True when the
 * datagram arrives, whether or not `adb shell` has ended. False when nothing arrived within `udpWaitMs` after the
 * device printed the line or `adb shell` ended with code 0. Null (unknown) when nothing arrived and `adb shell` failed
 * to run, ended with another code, or did neither within `LIMITS.shortMs` (nothing was sent). A run still going is
 * killed.
 */
export async function udpReaches(ctx: Context, serial: string, address: string): Promise<boolean | null> {
  const token = `ogw-${randomBytes(6).toString('hex')}`;
  const socket = createSocket('udp4');
  let child: ChildProcess | undefined;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, '0.0.0.0', () => {
        resolve(socket.address().port);
      });
    });
    return await new Promise<boolean | null>((resolve) => {
      let wait: NodeJS.Timeout | undefined;
      const limit = setTimeout(() => {
        end(null);
      }, LIMITS.shortMs);
      const end = (value: boolean | null): void => {
        clearTimeout(limit);
        clearTimeout(wait);
        resolve(value);
      };
      // the send has started: the datagram has `udpWaitMs` to arrive
      const sent = (): void => {
        wait ??= setTimeout(() => {
          end(false);
        }, udpWaitMs);
      };
      socket.on('message', (message) => {
        if (message.toString('utf8').includes(token)) end(true);
      });
      const command = `echo sending ${token}; echo ${token} | nc -u -q 1 ${address} ${String(port)}`;
      child = spawnTracked('adb', ['-s', serial, 'shell', command], { env: ctx.env, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.includes(token)) sent();
      });
      child.on('error', () => {
        end(null);
      });
      child.on('close', (code) => {
        if (code === 0) sent();
        else end(null);
      });
    });
  } finally {
    socket.close();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) killTree(child, 'SIGKILL');
  }
}

/** harness settings `testDevices`: in `adb devices`, and whether UDP from the device reaches the host. The devices are checked together. */
export async function deviceChecks(ctx: Context, settings: HarnessSettings): Promise<EnvCheckResult['testDevices']> {
  const devices = settings.testDevices ?? [];
  if (devices.length === 0) return [];
  const listed = await run('adb', ['devices'], { env: ctx.env, timeoutMs: LIMITS.shortMs }).catch(() => null);
  const connected = new Set(
    (listed?.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts[1] === 'device')
      .map((parts) => parts[0] as string),
  );
  const address = lanAddress();
  return Promise.all(
    devices.map(async (device) => {
      const isConnected = connected.has(device.serial);
      const udp = isConnected && address !== null ? await udpReaches(ctx, device.serial, address) : null;
      return { serial: device.serial, connected: isConnected, udp };
    }),
  );
}
