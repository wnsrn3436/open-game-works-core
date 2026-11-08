import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { isPlainObject } from '../../../lib/json.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { run } from '../../../lib/proc.ts';
import { CLAUDE_JSON_OUTPUT, type AgentCli } from '../../agent/lib/cli-command.ts';
import { claudeResultModels } from '../../agent/lib/usage.ts';
import { whichIn } from './host.ts';
import { CLI_DEFS, promptRun, type CliDef, type CliStates } from './hostcheck.ts';
import { net, requestJson } from './net.ts';
import type { BaseCliCheck, CliModel, CliModelsCheck, CliVersionCheck } from './results.ts';

/** The agent CLIs whose models and version `ogw env check` reads (ogw.md `## env check`). */
export const AGENT_CLIS: readonly AgentCli[] = ['claude-code', 'codex'];

/**
 * The base CLI: the agent CLI that runs this process, by the variable each sets in the environment of the shell
 * commands of its agents (Claude Code `CLAUDECODE=1`, Codex `CODEX_THREAD_ID`).
 */
export function baseCli(env: NodeJS.ProcessEnv): BaseCliCheck {
  const claude = env.CLAUDECODE === '1';
  const codex = (env.CODEX_THREAD_ID ?? '') !== '';
  if (claude && codex) return { cli: null, reason: 'CLAUDECODE is 1 and CODEX_THREAD_ID is set' };
  if (claude) return { cli: 'claude-code', reason: null };
  if (codex) return { cli: 'codex', reason: null };
  return { cli: null, reason: 'CLAUDECODE is not 1 and CODEX_THREAD_ID is not set' };
}

/** The Claude Code model aliases whose models the list names, in this order. */
export const CLAUDE_ALIASES: readonly string[] = ['fable', 'opus', 'sonnet', 'haiku'];

/** The role whose prompt run (outside the play and judge sandbox) the alias runs use. */
const ALIAS_RUN_ROLE = 'core';

/** The levels in the first parentheses of the description of `--effort` in `claude --help`; null without them. */
export function claudeHelpEfforts(help: string): string[] | null {
  const lines = help.split(/\r?\n/);
  const at = lines.findIndex((line) => /^\s*--effort\b/.test(line));
  if (at < 0) return null;
  const next = lines.findIndex((line, i) => i > at && /^\s*-/.test(line));
  const text = lines.slice(at, next < 0 ? undefined : next).join(' ');
  const levels = /\(([^)]*)\)/.exec(text)?.[1]?.split(',').map((level) => level.trim()).filter((level) => level !== '');
  return levels === undefined || levels.length === 0 ? null : levels;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 500 ? trimmed.slice(trimmed.length - 500) : trimmed;
}

/** The model of one alias: the one model the result object of its prompt run names (ogw.md `## env check`). */
async function claudeAliasModel(ctx: Context, alias: string, efforts: string[] | null): Promise<CliModel | string> {
  const result = await promptRun(ctx, { cli: 'claude-code', model: alias, effort: 'low' }, ALIAS_RUN_ROLE, {
    output: [...CLAUDE_JSON_OUTPUT, '--no-session-persistence'],
    env: {},
  });
  if (result.code !== 0 || result.timedOut) {
    return `${alias}: the prompt run ${result.timedOut ? 'timed out' : `ended with code ${String(result.code)}`}: ${tail(`${result.stderr}\n${result.stdout}`)}`;
  }
  const models = claudeResultModels(result.stdout);
  if (models === null) return `${alias}: the prompt run printed no result object`;
  if (models.length !== 1) return `${alias}: the result object names ${models.length === 0 ? 'no model' : `the models ${models.join(', ')}`}`;
  return { id: models[0] as string, alias, efforts, description: null };
}

/** Claude Code: one model per alias of `CLAUDE_ALIASES`, the aliases run together, with the efforts of `claude --help`. */
async function claudeModels(ctx: Context): Promise<CliModelsCheck> {
  const help = await run('claude', ['--help'], { env: ctx.env, timeoutMs: LIMITS.shortMs }).catch((error: unknown) => (error as Error).message);
  const efforts = typeof help === 'string' ? null : claudeHelpEfforts(`${help.stdout}\n${help.stderr}`);
  const results = await Promise.all(CLAUDE_ALIASES.map((alias) => claudeAliasModel(ctx, alias, efforts)));
  const unknown = results.filter((r): r is string => typeof r === 'string');
  if (typeof help === 'string') unknown.push(`efforts: cannot run claude --help: ${help}`);
  else if (efforts === null) unknown.push('efforts: claude --help lists no levels for --effort');
  return { cli: 'claude-code', models: results.filter((r): r is CliModel => typeof r !== 'string'), unknown };
}

/** Codex: the items of the catalog of `codex debug models` whose `visibility` is `list`, in catalog order. */
export function codexCatalogModels(stdout: string): CliModel[] | string {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    if (error instanceof SyntaxError) return 'codex debug models printed no JSON';
    throw error;
  }
  const items = isPlainObject(value) ? value.models : undefined;
  if (!Array.isArray(items)) return 'the output of codex debug models has no models array';
  const models: CliModel[] = [];
  for (const item of items) {
    if (!isPlainObject(item) || item.visibility !== 'list') continue;
    if (typeof item.slug !== 'string' || item.slug === '') return 'a listed model of codex debug models has no slug';
    const levels = Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels : [];
    const efforts = levels.flatMap((level) => (isPlainObject(level) && typeof level.effort === 'string' ? [level.effort] : []));
    models.push({ id: item.slug, alias: null, efforts, description: typeof item.description === 'string' ? item.description : null });
  }
  return models;
}

async function codexModels(env: NodeJS.ProcessEnv): Promise<CliModelsCheck> {
  const result = await run('codex', ['debug', 'models'], { env, timeoutMs: LIMITS.shortMs }).catch((error: unknown) => (error as Error).message);
  if (typeof result === 'string') return { cli: 'codex', models: [], unknown: [`cannot run codex debug models: ${result}`] };
  if (result.code !== 0) return { cli: 'codex', models: [], unknown: [`codex debug models ended with code ${String(result.code)}: ${tail(result.stderr)}`] };
  const models = codexCatalogModels(result.stdout);
  return typeof models === 'string' ? { cli: 'codex', models: [], unknown: [models] } : { cli: 'codex', models, unknown: [] };
}

/** The model list of each agent CLI that is installed and logged in (ogw.md `## env check`), the CLIs read together. */
export async function cliModelChecks(ctx: Context, cliState: CliStates): Promise<CliModelsCheck[]> {
  const lists = await Promise.all(
    AGENT_CLIS.map(async (cli) => {
      const state = await cliState(CLI_DEFS[cli] as CliDef);
      if (!state.installed || state.loggedIn !== true) return null;
      return cli === 'claude-code' ? claudeModels(ctx) : codexModels(ctx.env);
    }),
  );
  return lists.filter((list): list is CliModelsCheck => list !== null);
}

/** The first `<n>.<n>.<n>` of a text; null without one. */
export function versionIn(text: string): string | null {
  return /\b(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}

/** True when version `a` is lower than `b`, both `<n>.<n>.<n>`. */
export function versionLower(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}

/** Where an agent CLI was installed from: the source, the URL of its latest version, and the update command. */
export interface InstallSource {
  source: string;
  latest: () => Promise<string | null>;
  update: string;
}

/** The text of a URL, trimmed. */
async function requestText(url: string): Promise<string> {
  const response = await net().request(url);
  if (response.status !== 200) throw new Error(`GET ${url} answered ${String(response.status)}`);
  return response.body.toString('utf8').trim();
}

/** The install source that the real path of the program gives (ogw.md `## env check`); null when it matches none. */
export function installSource(real: string, home: string): InstallSource | null {
  const parts = real.split(sep);
  const cask = parts.indexOf('Caskroom');
  if (cask >= 0 && parts[cask + 1] !== undefined && cask + 2 < parts.length) {
    const name = parts[cask + 1] as string;
    return {
      source: `Homebrew cask ${name}`,
      latest: async () => {
        const version = (await requestJson<{ version?: unknown }>(`https://formulae.brew.sh/api/cask/${name}.json`)).version;
        return typeof version === 'string' ? versionIn(version) : null;
      },
      update: `brew upgrade --cask ${name}`,
    };
  }
  const cellar = parts.indexOf('Cellar');
  if (cellar >= 0 && parts[cellar + 1] !== undefined && cellar + 2 < parts.length) {
    const name = parts[cellar + 1] as string;
    return {
      source: `Homebrew formula ${name}`,
      latest: async () => {
        const stable = (await requestJson<{ versions?: { stable?: unknown } }>(`https://formulae.brew.sh/api/formula/${name}.json`)).versions?.stable;
        return typeof stable === 'string' ? versionIn(stable) : null;
      },
      update: `brew upgrade ${name}`,
    };
  }
  const modules = parts.lastIndexOf('node_modules');
  const scoped = parts[modules + 1]?.startsWith('@') === true;
  const name = parts.slice(modules + 1, modules + (scoped ? 3 : 2)).join('/');
  // the program is a file inside the package folder
  if (modules >= 0 && modules + (scoped ? 3 : 2) < parts.length) {
    return {
      source: `npm package ${name}`,
      latest: async () => {
        const version = (await requestJson<{ version?: unknown }>(`https://registry.npmjs.org/${name}/latest`)).version;
        return typeof version === 'string' ? versionIn(version) : null;
      },
      update: `npm install --global ${name}@latest`,
    };
  }
  const installer = join(home, '.local', 'share', 'claude', 'versions') + sep;
  if (real.startsWith(installer)) {
    return { source: 'Claude Code installer', latest: async () => versionIn(await requestText('https://downloads.claude.ai/claude-code-releases/latest')), update: 'claude update' };
  }
  return null;
}

/** The installed version of one agent CLI against the latest version its install source publishes. */
async function cliVersion(env: NodeJS.ProcessEnv, cli: AgentCli, program: string, path: string): Promise<CliVersionCheck> {
  const none = { cli, installed: null, source: null, latest: null, behind: null, update: null };
  const printed = await run(program, ['--version'], { env, timeoutMs: LIMITS.shortMs }).catch((error: unknown) => (error as Error).message);
  // the first version the program prints, whatever its exit code (ogw.md `## env check`)
  const installed = typeof printed === 'string' ? null : versionIn(`${printed.stdout}\n${printed.stderr}`);
  const real = await realpath(path);
  const from = installSource(real, env.HOME ?? homedir());
  if (from === null) return { ...none, installed, reason: `${real} is not under a Homebrew cask, a Homebrew formula, an npm package or the Claude Code installer` };
  const known = { ...none, installed, source: from.source, update: from.update };
  if (typeof printed === 'string') return { ...known, reason: `cannot run ${program} --version: ${printed}` };
  if (installed === null) {
    const ended = printed.timedOut ? 'passed its time limit' : `ended with code ${String(printed.code ?? printed.signal)}`;
    return { ...known, reason: `${program} --version printed no version and ${ended}` };
  }
  const latest = await from.latest().catch((error: unknown) => (error as Error).message);
  if (latest === null) return { ...known, reason: `${from.source} gives no latest version` };
  if (!/^\d+\.\d+\.\d+$/.test(latest)) return { ...known, reason: `cannot read the latest version of ${from.source}: ${latest}` };
  return { ...known, latest, behind: versionLower(installed, latest), reason: null };
}

/** The version of each agent CLI that is installed, against the latest published one (ogw.md `## env check`). */
export async function cliVersionChecks(env: NodeJS.ProcessEnv): Promise<CliVersionCheck[]> {
  const checks = await Promise.all(
    AGENT_CLIS.map(async (cli) => {
      const program = (CLI_DEFS[cli] as CliDef).program;
      const path = await whichIn(env, program);
      return path === null ? null : cliVersion(env, cli, program, path);
    }),
  );
  return checks.filter((check): check is CliVersionCheck => check !== null);
}
