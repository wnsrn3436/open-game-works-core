import { expectPositionals, str, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import type { HarnessSettings } from '../../lib/settings.ts';
import { toolProgram } from './api.ts';
import { engineSources, installedEngine, type EngineSource, type EngineSourceFailure } from './lib/engines.ts';
import { hostPlatform } from './lib/host.ts';
import { agentCliChecks, buildToolChecks, cliStates, deviceChecks, hostInfo, programChecks, providerCliChecks, tokenCheckRun } from './lib/hostcheck.ts';
import { ghStatus } from './lib/probe.ts';
import { harnessSecretService } from '../../lib/secrets.ts';
import { bearerValueProblem, loginTokenRoles, storedLoginToken } from '../secret/lib/login-token.ts';
import { AGENT_LOGIN_TOKEN_SECRET } from '../secret/lib/names.ts';
import { agentCliLabel, loginTokenError, loginTokenState, writeEnvResult, type EnvCheckResult, type PinSecretCheck } from './lib/results.ts';
import { postgresPresent, TOOL_NAMES } from './lib/tools.ts';

type ForCommand = 'create-server-core' | 'create-client-core' | 'update-core';

const FOR_ITEMS: Record<ForCommand, readonly string[]> = {
  'create-server-core': ['tools.postgresql'],
  // `tools.gdtoolkit` needs the Godot version of the engine.json that `create client core` writes: it is got then
  'create-client-core': ['tools.chromium'],
  'update-core': ['tools.postgresql', 'tools.chromium', 'tools.gdtoolkit'],
};

async function itemPresent(ctx: Context, settings: HarnessSettings, item: string): Promise<boolean> {
  if (item === 'tools.postgresql') return postgresPresent(ctx, settings.tools.postgresql);
  return (await toolProgram(ctx, item === 'tools.chromium' ? 'chromium' : 'gdtoolkit')) !== null;
}

async function checkFor(ctx: Context, target: string): Promise<{ exitCode: number; text: string; data: unknown }> {
  if (!Object.hasOwn(FOR_ITEMS, target)) throw new OgwError(`--for must be create-server-core, create-client-core or update-core`);
  const settings = await ctx.settings();
  const items = FOR_ITEMS[target as ForCommand];
  const present = await Promise.all(items.map((item) => itemPresent(ctx, settings, item)));
  const missing = items.filter((_, i) => !present[i]);
  if (missing.length === 0) return { exitCode: 0, text: 'all present', data: { missing } };
  return { exitCode: 1, text: `missing: ${missing.join(', ')}\nRun update env first.`, data: { missing } };
}

async function toolChecks(ctx: Context, settings: HarnessSettings): Promise<EnvCheckResult['tools']> {
  const [programs, postgresql] = await Promise.all([Promise.all(TOOL_NAMES.map((name) => toolProgram(ctx, name))), postgresPresent(ctx, settings.tools.postgresql)]);
  const tools: EnvCheckResult['tools'] = {};
  TOOL_NAMES.forEach((name, i) => {
    tools[name] = { pinned: settings.tools[name] !== undefined, installed: programs[i] !== null };
  });
  tools.postgresql = { pinned: true, installed: postgresql };
  return tools;
}

async function engineChecks(ctx: Context): Promise<{ sources: EngineSource[]; engines: EnvCheckResult['engines']; errors: EngineSourceFailure[] }> {
  const { sources, failures } = await engineSources(ctx);
  const engines = await Promise.all(
    sources.map(async (s) => ({ engine: s.engine, version: s.version, from: s.from, installed: (await installedEngine(ctx, s.engine, s.version)) !== null })),
  );
  return { sources, engines, errors: failures };
}

/** The `secret` of every hf pin and whether the host secret store has it. */
export function pinSecretChecks(ctx: Context, settings: HarnessSettings): PinSecretCheck[] {
  return settings.resourceGeneration.flatMap((method) =>
    (method.pins ?? []).flatMap((pin) =>
      pin.kind === 'hf' && pin.secret !== undefined ? [{ secret: pin.secret, method: method.name, source: pin.source, stored: ctx.secrets.get(harnessSecretService(pin.secret)) !== null }] : [],
    ),
  );
}

/**
 * Whether the play or judge agent CLI is Claude Code, whether the agent login token secret is stored, and the token
 * check run with it when both hold.
 */
export async function agentLoginTokenCheck(ctx: Context, settings: HarnessSettings): Promise<NonNullable<EnvCheckResult['agentLoginToken']>> {
  const needed = loginTokenRoles(settings).length > 0;
  const token = storedLoginToken(ctx);
  // the checks of `ogw secret set` in its order: no run for a value that cannot be a Bearer value
  const valueProblem = needed && token !== null ? bearerValueProblem(token) : null;
  const run = needed && token !== null && valueProblem === null ? await tokenCheckRun(ctx, settings, token) : null;
  return { needed, stored: token !== null, valueProblem, run };
}

/** Runs the independent checks together; the build tools wait only for the engine sources. */
export async function hostCheck(ctx: Context): Promise<EnvCheckResult> {
  const settings = await ctx.settings();
  const platform = hostPlatform(ctx.env);
  const checkedAt = Date.now();
  // a CLI that is both an agent CLI and a provider CLI is checked once
  const states = cliStates(ctx.env);
  const [host, programs, gh, engineResult, tools, agentClis, providerClis, testDevices, agentLoginToken] = await Promise.all([
    hostInfo(ctx, platform),
    programChecks(ctx.env),
    ghStatus(ctx.env),
    engineChecks(ctx).then(async (e) => ({ ...e, buildTools: await buildToolChecks(ctx, e.sources, platform) })),
    toolChecks(ctx, settings),
    agentCliChecks(ctx, settings, states),
    providerCliChecks(ctx, settings, states),
    deviceChecks(ctx, settings),
    agentLoginTokenCheck(ctx, settings),
  ]);
  return {
    checkedAt,
    host,
    programs,
    gh,
    engines: engineResult.engines,
    engineErrors: engineResult.errors,
    tools,
    buildTools: engineResult.buildTools,
    agentClis,
    providerClis,
    testDevices,
    pinSecrets: pinSecretChecks(ctx, settings),
    agentLoginToken,
  };
}

function loginTokenText(check: NonNullable<EnvCheckResult['agentLoginToken']>): string {
  const state = loginTokenState(check);
  if (state === null) return 'stored';
  return state === 'invalid' || state === 'unverified' ? `${state}: ${loginTokenError(check)}` : state;
}

function yesNo(value: boolean | null): string {
  return value === null ? 'unknown' : value ? 'yes' : 'no';
}

export function checkText(r: EnvCheckResult): string {
  const lines = [
    `host: ${r.host.platform ?? 'unsupported'} ${r.host.os}, ${String(r.host.cpu.count)} CPU ${r.host.cpu.model}, memory ${String(r.host.memoryBytes)} bytes, free disk ${String(r.host.freeDiskBytes ?? 'unknown')} bytes`,
    ...Object.entries(r.programs).map(([name, p]) => `program ${name}: ${p.found ? (p.version ?? '') : 'missing'}`),
    `gh login: ${yesNo(r.gh.loggedIn)}, scopes: ${r.gh.scopes.join(', ')}`,
    ...r.engines.map((e) => `engine ${e.engine} ${e.version} (${e.from}): ${e.installed ? 'installed' : 'missing'}`),
    ...r.engineErrors.map((e) => `engine.json (${e.from}): ${e.reason}`),
    ...Object.entries(r.tools).map(([name, t]) => `tools.${name}: ${t.pinned ? (t.installed ? 'installed' : 'missing') : 'not pinned'}`),
    ...r.buildTools.map((t) => {
      const state = t.ok ? 'ok' : t.downloadable ? 'missing (ogw env install-engines)' : `install ${t.name} ${t.version}`;
      return `build tool ${t.name} ${t.version} for ${t.platform} (${t.from}): ${state}`;
    }),
    ...r.agentClis.map((a) => `agent CLI ${agentCliLabel(a)}: installed ${yesNo(a.installed)}, login ${yesNo(a.loggedIn)}, prompt run ${a.run?.ok ? 'ok' : `failed: ${a.run?.output ?? ''}`}`),
    ...r.providerClis.map(
      (p) => `provider CLI ${p.provider} (${p.methods.join(', ')}): installed ${yesNo(p.installed)}, login ${yesNo(p.loggedIn)}, billing ${p.billing ?? 'unknown'}${p.detail ? ` (${p.detail})` : ''}`,
    ),
    ...r.testDevices.map((d) => `test device ${d.serial}: connected ${yesNo(d.connected)}, UDP ${yesNo(d.udp)}`),
    ...(r.pinSecrets ?? []).map((s) => `pin secret ${s.secret} (${s.method} ${s.source}): ${s.stored ? 'stored' : 'missing'}`),
    ...(r.agentLoginToken?.needed === true ? [`agent login token ${AGENT_LOGIN_TOKEN_SECRET}: ${loginTokenText(r.agentLoginToken)}`] : []),
  ];
  return lines.join('\n');
}

export const checkCommand: CommandDef = {
  name: ['env', 'check'],
  usage: 'ogw env check [--for <create-server-core|create-client-core|update-core>]',
  options: { for: { type: 'string' } },
  async run(ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    const target = str(args, 'for');
    if (target !== undefined) return checkFor(ctx, target);
    const result = await hostCheck(ctx);
    const path = await writeEnvResult(ctx, 'env-check', result);
    return { text: `${checkText(result)}\nresult: ${path}`, data: { ...result, resultFile: path } };
  },
};
