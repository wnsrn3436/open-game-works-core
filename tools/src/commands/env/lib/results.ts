import type { Context } from '../../../lib/command.ts';
import { readJsonIfExists, writeJsonAtomic } from '../../../lib/fsx.ts';
import type { Mismatch } from './files.ts';
import { envResultPath, type EnvResultName } from './host.ts';

export interface ProgramCheck {
  found: boolean;
  version: string | null;
}

export interface AgentCliCheck {
  cli: string;
  /** Model and effort of the roles; the prompt runs with them. Missing in results of an older ogw. */
  model?: string;
  effort?: string;
  /** The prompt ran in the play and judge OS sandbox. Missing in results of an older ogw. */
  sandboxed?: boolean;
  roles: string[];
  installed: boolean;
  loggedIn: boolean | null;
  /** The short prompt run in a new empty folder. */
  run: { ok: boolean; exitCode: number | null; output: string } | null;
}

/** The agent CLI and, when the result has them, the model, effort and sandbox of its prompt run. */
export function agentCliLabel(check: AgentCliCheck): string {
  if (check.model === undefined) return check.cli;
  return `${check.cli} (model ${check.model}, effort ${check.effort ?? ''}${check.sandboxed === true ? ', sandboxed' : ''})`;
}

/** How the provider calls of a method are paid: the subscription of the provider login, or per call. */
export type ProviderBilling = 'subscription' | 'per-call';

export interface ProviderCliCheck {
  provider: string;
  methods: string[];
  installed: boolean;
  /** null when the login could not be checked. */
  loggedIn: boolean | null;
  /** null when it is not known or no call can run. Missing in results of an older ogw. */
  billing?: ProviderBilling | null;
  /** The codex login kind, or the grok login file and whether XAI_API_KEY is set. */
  detail: string | null;
}

export interface BuildToolCheck {
  from: string;
  platform: string;
  name: string;
  version: string;
  downloadable: boolean;
  /** downloadable: installed by `ogw env install-engines`. Otherwise: the version command printed the version. */
  ok: boolean;
  output: string | null;
}

/** The token check run (`tools/ogw.md` `## secret set`) with a login token. */
export interface TokenCheck {
  /** The play or judge role whose agent settings and sandbox the run used. */
  role: string;
  /** Exit code 0 within the time limit and no authentication failure. */
  ok: boolean;
  /** Claude Code failed to authenticate with the token: an assistant message has `error` `authentication_failed`. */
  authFailed: boolean;
  exitCode: number | null;
  /** The error of the run: the result message text, else stderr, else stdout; the time limit when it timed out. */
  output: string;
}

/** The state of the agent login token: `missing`, rejected by Claude Code (`invalid`), or a token check run that failed otherwise (`unverified`). */
export type LoginTokenState = 'missing' | 'valid' | 'invalid' | 'unverified';

/**
 * The state of the agent login token in an `agentLoginToken` result: `invalid` when the stored value cannot be an HTTP
 * Bearer value or Claude Code failed to authenticate with it. Null when nothing checked a stored token.
 */
export function loginTokenState(check: NonNullable<EnvCheckResult['agentLoginToken']>): LoginTokenState | null {
  if (!check.stored) return 'missing';
  if (typeof check.valueProblem === 'string') return 'invalid';
  const run = check.run ?? null;
  if (run === null) return null;
  return run.ok ? 'valid' : run.authFailed ? 'invalid' : 'unverified';
}

/** Why the stored agent login token is `invalid` or `unverified`: its value problem, else the error of its token check run. */
export function loginTokenError(check: NonNullable<EnvCheckResult['agentLoginToken']>): string {
  return typeof check.valueProblem === 'string' ? `not an HTTP Authorization Bearer value: ${check.valueProblem}` : (check.run?.output ?? '');
}

export interface PinSecretCheck {
  secret: string;
  method: string;
  /** The hf repository of the pin. */
  source: string;
  stored: boolean;
}

export interface EnvCheckResult {
  checkedAt: number;
  host: {
    platform: string | null;
    os: string;
    cpu: { model: string; count: number };
    memoryBytes: number;
    freeDiskBytes: number | null;
  };
  programs: Record<string, ProgramCheck>;
  gh: { loggedIn: boolean; scopes: string[] };
  engines: { engine: string; version: string; from: string; installed: boolean }[];
  /** `engine.json` sources that could not be read. */
  engineErrors: { from: string; reason: string }[];
  tools: Record<string, { pinned: boolean; installed: boolean }>;
  buildTools: BuildToolCheck[];
  agentClis: AgentCliCheck[];
  providerClis: ProviderCliCheck[];
  testDevices: { serial: string; connected: boolean; udp: boolean | null }[];
  /** The `secret` of hf pins and whether the host secret store has it. Missing in results of an older ogw. */
  pinSecrets?: PinSecretCheck[];
  /**
   * The play or judge agent CLI is Claude Code (`needed`), whether the host secret store has the harness secret
   * `claude-code-oauth-token`, why the stored value cannot be an HTTP Bearer value (`valueProblem`), and the token check
   * run with it when it is needed, stored and a Bearer value (`run`). `valueProblem` and `run` are missing in results of
   * an older ogw; the whole field is too.
   */
  agentLoginToken?: { needed: boolean; stored: boolean; valueProblem?: string | null; run?: TokenCheck | null };
}

export interface InstallEntry {
  installed: boolean;
  reason: string | null;
  mismatches: Mismatch[];
}

export interface GenerationInstallResult {
  installedAt: number;
  methods: Record<string, InstallEntry & { kind: string; secretMissing?: string }>;
  tools: Record<string, InstallEntry>;
}

export interface MeasuredRun {
  resolution?: number;
  durationMs?: number;
  jobMs?: number;
  result: 'ok' | 'failed' | 'timeout';
  maxMemoryBytes: number | null;
  output: string | null;
  blocked: string[];
  /** external-service methods: the cost of the call in USD; a `provider` method's call costs 0. */
  costUsd?: number;
  /** Why the step failed, when no program output says it. */
  detail?: string;
  /** `failed` or `timeout` of a call: the last lines of its stderr (`callError`). */
  error?: string;
}

export interface GenerationMeasureResult {
  measuredAt: number;
  methods: Record<string, { kind: string; steps: MeasuredRun[]; error: string | null }>;
}

export interface InstanceMeasureTarget {
  name: string;
  kind: 'benchmark' | 'game';
  /** Largest instance count that kept the fps condition with no abnormal end. */
  value: number;
  detail: string | null;
}

export interface InstanceMeasureResult {
  measuredAt: number;
  targets: InstanceMeasureTarget[];
}

export interface EnvResults {
  'env-check': EnvCheckResult;
  'generation-install': GenerationInstallResult;
  'generation-measure': GenerationMeasureResult;
  'instance-measure': InstanceMeasureResult;
}

export async function writeEnvResult<K extends EnvResultName>(ctx: Context, name: K, value: EnvResults[K]): Promise<string> {
  const path = await envResultPath(ctx.env, name);
  await writeJsonAtomic(path, value);
  return path;
}

export async function readEnvResult<K extends EnvResultName>(ctx: Context, name: K): Promise<EnvResults[K] | null> {
  return readJsonIfExists<EnvResults[K]>(await envResultPath(ctx.env, name));
}
