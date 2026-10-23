import { OgwError } from './errors.ts';
import { resolveGame, type GameRepo } from './game.ts';
import { loadHarnessSettings, workspaceFrom, type HarnessSettings, type Workspace } from './settings.ts';
import { secretStore, type SecretStore } from './secrets.ts';

export type OptionValue = string | boolean | string[] | undefined;

export interface OptionSpec {
  type: 'string' | 'boolean';
  /** A `string` option that takes one or more values: `--x a b` or `--x a --x b`. */
  multiple?: boolean;
}

export interface CommandArgs {
  positionals: string[];
  values: Record<string, OptionValue>;
  /** Tokens after the command name, as given (with `--json` and `--background` removed). */
  raw: string[];
}

export interface CommandResult {
  exitCode?: number;
  /** Printed in text mode. */
  text?: string;
  /** Printed as JSON with `--json`. */
  data?: unknown;
  /** Value recorded in the agent run log for this command. */
  summary?: unknown;
}

export interface Context {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** All of stdin as text. */
  stdin(): Promise<string>;
  /** A progress line on stderr. */
  log(line: string): void;
  settings(): Promise<HarnessSettings>;
  workspace(): Promise<Workspace>;
  game(name: string): Promise<GameRepo>;
  secrets: SecretStore;
  /** True when stdin and stdout are both a terminal: a human runs the command. */
  terminal(): boolean;
  /** Job id when this command runs as a background job. */
  jobId: string | null;
}

export interface CommandDef {
  /** Command words after `ogw`, for example `['loop', 'start']`. */
  name: readonly string[];
  usage: string;
  options?: Record<string, OptionSpec>;
  /** Receive the tokens after the name in `raw` only; no option parsing. */
  raw?: boolean;
  /**
   * Tokens after this many positionals are more positionals, as given: `--json`, `--help`, `--`, and option-like
   * tokens among them are not taken as flags. Only for commands whose options take no value.
   */
  verbatimAfter?: number;
  /** Accepts `--background`. `game` names the game the job works on. */
  background?: {
    game?: (args: CommandArgs) => string | null;
    /** Time limit of the job process. */
    timeLimitMs: (args: CommandArgs, settings: HarnessSettings) => number;
    /** Refuses the args before the job starts by throwing `OgwError`. */
    validate?: (ctx: Context, args: CommandArgs) => Promise<void>;
  };
  run(ctx: Context, args: CommandArgs): Promise<CommandResult>;
}

/** Parses tokens by an option spec. Unknown options are an error. */
export function parseTokens(tokens: readonly string[], spec: Record<string, OptionSpec>): CommandArgs {
  const positionals: string[] = [];
  const values: Record<string, OptionValue> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (token === '--') {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (!token.startsWith('--') || token.length === 2) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const option = spec[name];
    if (!option) throw new OgwError(`unknown option --${name}`);
    if (option.type === 'boolean') {
      if (eq !== -1) throw new OgwError(`option --${name} takes no value`);
      values[name] = true;
      continue;
    }
    const taken = eq === -1 ? takeValues(tokens, i + 1, option.multiple === true) : [token.slice(eq + 1)];
    if (eq === -1) i += taken.length;
    storeValue(values, name, option, taken);
  }
  return { positionals, values, raw: [...tokens] };
}

function takeValues(tokens: readonly string[], from: number, multiple: boolean): string[] {
  const taken: string[] = [];
  for (let i = from; i < tokens.length && !(tokens[i] as string).startsWith('--'); i++) {
    taken.push(tokens[i] as string);
    if (!multiple) break;
  }
  return taken;
}

function storeValue(values: Record<string, OptionValue>, name: string, option: OptionSpec, taken: string[]): void {
  if (taken.length === 0) throw new OgwError(`option --${name} needs a value`);
  if (option.multiple) {
    const previous = values[name];
    values[name] = [...(Array.isArray(previous) ? previous : []), ...taken];
    return;
  }
  if (values[name] !== undefined) throw new OgwError(`option --${name} given twice`);
  values[name] = taken[0];
}

export function str(args: CommandArgs, name: string): string | undefined {
  const value = args.values[name];
  return typeof value === 'string' ? value : undefined;
}

/** An option holding a non-negative safe integer (such as a ms value), or undefined when it is not given. */
export function nonNegativeInt(args: CommandArgs, name: string): number | undefined {
  const given = str(args, name);
  if (given === undefined) return undefined;
  const value = Number(given);
  if (!/^[0-9]+$/.test(given) || !Number.isSafeInteger(value)) throw new OgwError(`invalid --${name}: ${given}`);
  return value;
}

export function list(args: CommandArgs, name: string): string[] {
  const value = args.values[name];
  return Array.isArray(value) ? value : [];
}

export function flag(args: CommandArgs, name: string): boolean {
  return args.values[name] === true;
}

/** The positional at `index`; fails with the usage when it is missing. */
export function positional(args: CommandArgs, index: number, what: string): string {
  const value = args.positionals[index];
  if (value === undefined) throw new OgwError(`missing ${what}`);
  return value;
}

export function expectPositionals(args: CommandArgs, min: number, max: number, usage: string): void {
  const n = args.positionals.length;
  if (n < min || n > max) throw new OgwError(`usage: ${usage}`);
}

export interface ContextInit {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: () => Promise<string>;
  stderr: (text: string) => void;
  /** True when stdin and stdout are both a terminal; without it, never. */
  terminal?: () => boolean;
}

export function createContext(init: ContextInit): Context {
  let settings: Promise<HarnessSettings> | null = null;
  const ctx: Context = {
    cwd: init.cwd,
    env: init.env,
    stdin: init.stdin,
    log: (line) => {
      init.stderr(`${line}\n`);
    },
    settings: () => (settings ??= loadHarnessSettings(init.env)),
    workspace: async () => workspaceFrom(await ctx.settings(), init.env),
    game: async (name) => resolveGame(await ctx.workspace(), name, init.cwd, init.env),
    secrets: secretStore(init.env),
    terminal: () => init.terminal?.() === true,
    jobId: init.env.OGW_JOB_ID ?? null,
  };
  return ctx;
}
