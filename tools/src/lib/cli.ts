import { writeSync } from 'node:fs';
import { agentContext, appendRunLog, finishRunLog, type AgentContext } from './agentctx.ts';
import { BROKER_RUN, STDIN_REQUEST } from './broker-client.ts';
import {
  createContext,
  parseTokens,
  type CommandArgs,
  type CommandDef,
  type CommandResult,
  type Context,
} from './command.ts';
import { OgwError } from './errors.ts';
import { startJob, superviseJob, updateJob } from './jobs.ts';

export interface CliIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** True when stdin and stdout are both a terminal; without it, never. */
  terminal?: () => boolean;
}

/** The command whose name is the longest prefix of argv. */
export function findCommand(commands: readonly CommandDef[], argv: readonly string[]): CommandDef | null {
  let best: CommandDef | null = null;
  for (const def of commands) {
    if (def.name.length > argv.length) continue;
    if (!def.name.every((word, i) => argv[i] === word)) continue;
    if (!best || def.name.length > best.name.length) best = def;
  }
  return best;
}

function usageList(commands: readonly CommandDef[]): string {
  return ['usage: ogw <command> [--json]', ...commands.map((def) => `  ${def.usage}`)].join('\n');
}

function withoutFlag(tokens: readonly string[], name: string): { tokens: string[]; found: boolean } {
  const rest = tokens.filter((token) => token !== `--${name}`);
  return { tokens: rest, found: rest.length !== tokens.length };
}

function print(io: CliIo, json: boolean, result: CommandResult): void {
  if (json) io.stdout(`${JSON.stringify(result.data ?? { text: result.text ?? '' }, null, 2)}\n`);
  else if (result.text !== undefined && result.text !== '') io.stdout(result.text.endsWith('\n') ? result.text : `${result.text}\n`);
}

/**
 * Starts `def` with `args` as a background job, as `--background` does; the result names the job. An agent's job is
 * recorded in its run log.
 */
export async function startBackground(
  ctx: Context,
  def: CommandDef,
  args: CommandArgs,
  agent: AgentContext | null,
): Promise<CommandResult> {
  if (!def.background) throw new OgwError(`${def.name.join(' ')} does not take --background`);
  await def.background.validate?.(ctx, args);
  const settings = await ctx.settings();
  const argv = [...def.name, ...args.raw];
  const id = await startJob({
    argv,
    cwd: ctx.cwd,
    command: def.name.join(' '),
    game: def.background.game?.(args) ?? null,
    timeLimitMs: def.background.timeLimitMs(args, settings),
    agentJob: agent?.job.id ?? null,
    env: ctx.env,
  });
  if (agent) {
    await appendRunLog(agent, { command: `ogw ${argv.join(' ')}`, startedAt: Date.now(), exitCode: null, summary: null, job: id });
  }
  return { text: id, data: { job: id } };
}

interface Prepared {
  def: CommandDef;
  tokens: string[];
  /** Tokens after `def.verbatimAfter` positionals: positionals as given. */
  verbatim: string[];
  json: boolean;
  background: boolean;
}

/** Index of the first token after `count` positionals (tokens that do not start with `--`), or the token count. */
function verbatimStart(tokens: readonly string[], count: number): number {
  let seen = 0;
  for (let i = 0; i < tokens.length && seen < count; i++) {
    if (!(tokens[i] as string).startsWith('--') && ++seen === count) return i + 1;
  }
  return tokens.length;
}

/** Splits the tokens after a command name into the tokens to parse and the positionals after `def.verbatimAfter`. */
function splitVerbatim(def: CommandDef, all: readonly string[]): { tokens: string[]; verbatim: string[] } {
  const split = def.verbatimAfter === undefined ? all.length : verbatimStart(all, def.verbatimAfter);
  return { tokens: all.slice(0, split), verbatim: all.slice(split) };
}

function parseArgs(def: CommandDef, tokens: readonly string[], verbatim: readonly string[]): CommandArgs {
  const args = def.raw ? { positionals: [], values: {}, raw: [...tokens] } : parseTokens(tokens, def.options ?? {});
  args.positionals.push(...verbatim);
  args.raw.push(...verbatim);
  return args;
}

/**
 * An ogw command line (argv without `ogw`) that a command starts as a background job: its command and args, parsed
 * as the CLI parses them, with `--json` taken out. Refuses an empty line, `--background` in it, a command that does
 * not exist, and a command that does not take `--background`.
 */
export function backgroundCommandOf(commands: readonly CommandDef[], argv: readonly string[]): { def: CommandDef; args: CommandArgs; self: boolean } {
  if (argv.length === 0) throw new OgwError('empty command');
  const line = argv.join(' ');
  if (argv.includes('--background')) throw new OgwError(`${line}: --background is not taken`);
  const def = findCommand(commands, argv);
  if (!def) throw new OgwError(`${line}: no such command`);
  // a command with a `--background` option of its own (`ogw agent`) starts its job itself when given it
  const self = def.options?.background?.type === 'boolean';
  if ((!def.background && !self) || def.raw) throw new OgwError(`${line}: ${def.name.join(' ')} does not take --background`);
  const { tokens, verbatim } = splitVerbatim(def, argv.slice(def.name.length));
  const parsed = withoutFlag(tokens, 'json').tokens;
  return { def, args: parseArgs(def, self ? [...parsed, '--background'] : parsed, verbatim), self };
}

/** Finds the command and takes `--json` and `--background` out of its tokens. */
function prepare(commands: readonly CommandDef[], argv: readonly string[], io: CliIo): Prepared | number {
  const def = findCommand(commands, argv);
  if (!def) {
    const wantsHelp = argv.length === 0 || argv[0] === '--help';
    (wantsHelp ? io.stdout : io.stderr)(`${usageList(commands)}\n`);
    return wantsHelp ? 0 : 1;
  }
  const all = argv.slice(def.name.length);
  if (def.raw) return { def, tokens: all, verbatim: [], json: false, background: false };
  const { tokens, verbatim } = splitVerbatim(def, all);
  const noJson = withoutFlag(tokens, 'json');
  const noBackground = def.background ? withoutFlag(noJson.tokens, 'background') : { tokens: noJson.tokens, found: false };
  if (noBackground.tokens.includes('--help') && !def.options?.help) {
    io.stdout(`usage: ${def.usage}\n`);
    return 0;
  }
  return { def, tokens: noBackground.tokens, verbatim, json: noJson.found, background: noBackground.found };
}

function reportError(io: CliIo, json: boolean, error: unknown): number {
  if (!(error instanceof OgwError)) {
    io.stderr(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return 1;
  }
  if (json) io.stdout(`${JSON.stringify({ error: error.message, data: error.data ?? null }, null, 2)}\n`);
  io.stderr(`${error.message}\n`);
  return error.exitCode;
}

/** Runs one ogw invocation and returns its exit code. Commands never call process.exit. */
export async function runCli(commands: readonly CommandDef[], argv: readonly string[], io: CliIo): Promise<number> {
  if (argv[0] === '__job-supervise' && argv[1]) {
    await superviseJob(argv[1], io.env);
    return 0;
  }
  // a command a play or judge agent's broker runs: stdin comes from the broker, asked for through fd 3
  if (argv[0] === BROKER_RUN) return runCommand(commands, argv.slice(1), { ...io, stdin: () => brokerStdin(io), terminal: undefined });
  return runCommand(commands, argv, io);
}

function brokerStdin(io: CliIo): Promise<string> {
  try {
    writeSync(3, STDIN_REQUEST);
  } catch {
    // no broker on fd 3: stdin as it is
  }
  return io.stdin();
}

async function runCommand(commands: readonly CommandDef[], argv: readonly string[], io: CliIo): Promise<number> {
  const prepared = prepare(commands, argv, io);
  if (typeof prepared === 'number') return prepared;
  const { def, tokens, verbatim, json, background } = prepared;
  const ctx = createContext({ cwd: io.cwd, env: io.env, stdin: io.stdin, stderr: io.stderr, terminal: io.terminal });
  let agent: AgentContext | null = null;
  let logIndex = -1;
  try {
    const args = parseArgs(def, tokens, verbatim);
    agent = await agentContext(io.env);
    if (background) {
      print(io, json, await startBackground(ctx, def, args, agent));
      return 0;
    }
    if (agent && !ctx.jobId) {
      const command = `ogw ${[...def.name, ...tokens, ...verbatim].join(' ')}`;
      logIndex = await appendRunLog(agent, { command, startedAt: Date.now(), exitCode: null, summary: null });
    }
    const result = await def.run(ctx, args);
    const exitCode = result.exitCode ?? 0;
    print(io, json, result);
    await recordEnd(ctx, agent, logIndex, exitCode, result.summary ?? null);
    return exitCode;
  } catch (error) {
    const exitCode = reportError(io, json, error);
    await recordEnd(ctx, agent, logIndex, exitCode, null).catch(() => undefined);
    return exitCode;
  }
}

async function recordEnd(ctx: Context, agent: AgentContext | null, index: number, exitCode: number, summary: unknown): Promise<void> {
  if (ctx.jobId) {
    await updateJob(ctx.jobId, (job) => {
      job.summary = summary;
    }, ctx.env);
  }
  if (agent && index >= 0) await finishRunLog(agent, index, exitCode, summary);
}
