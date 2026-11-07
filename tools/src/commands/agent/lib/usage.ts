import { isPlainObject, type JsonObject } from '../../../lib/json.ts';
import type { AgentSettings } from '../../../lib/settings.ts';
import { agentCli, type AgentCli } from './cli-command.ts';

/** The usage of an `ogw agent` job (ogw.md `### usage` of `## agent`). */
export interface AgentUsage {
  cli: AgentCli;
  model: string;
  effort: string;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** Why `costUsd` is null (`COST_UNKNOWN`); null when it is a number. */
  costUnknown: string | null;
  turns: number | null;
}

/** The reasons a job has no cost (ogw.md `### usage` of `## agent`). `ogw` has no price table to price tokens. */
export const COST_UNKNOWN = {
  codex: 'codex prints no money cost',
  noUsageLine: 'no usage line',
  session: 'session before the job unknown',
} as const;

/** The token counts and cost a CLI printed: for a Claude Code job that continues a session, those of the whole session. */
export interface SessionUsage {
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

/** What the CLI printed: the counts and cost, and its turn count. */
export interface PrintedUsage extends SessionUsage {
  turns: number | null;
}

/** The fields of `SessionUsage`, which a continued session subtracts. */
export const SESSION_FIELDS = ['inputTokens', 'cachedTokens', 'outputTokens', 'costUsd'] as const;

/** The JSON object a line is, else null. */
function lineObject(line: string): JsonObject | null {
  const text = line.trim();
  if (!text.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** The last line of `log` that is a JSON object `matches` takes, else null. */
function lastObject(log: string, matches: (object: JsonObject) => boolean): JsonObject | null {
  const lines = log.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const object = lineObject(lines[i] as string);
    if (object !== null && matches(object)) return object;
  }
  return null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function money(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The sum of `fields` over the models of Claude Code `modelUsage`; null when a model lacks a count. */
function modelSum(models: JsonObject[], fields: readonly string[]): number | null {
  let sum = 0;
  for (const model of models) {
    for (const field of fields) {
      const n = count(model[field]);
      if (n === null) return null;
      sum += n;
    }
  }
  return sum;
}

/** Claude Code: the last result object, its tokens summed over the models of `modelUsage`. */
export function claudeUsage(log: string): PrintedUsage | null {
  const result = lastObject(log, (object) => object.type === 'result');
  if (result === null) return null;
  const modelUsage = result.modelUsage;
  const models = isPlainObject(modelUsage) ? Object.values(modelUsage).filter(isPlainObject) : null;
  const tokens = (fields: readonly string[]): number | null => (models === null ? null : modelSum(models, fields));
  return {
    inputTokens: tokens(['inputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens']),
    cachedTokens: tokens(['cacheReadInputTokens']),
    outputTokens: tokens(['outputTokens']),
    costUsd: money(result.total_cost_usd),
    turns: count(result.num_turns),
  };
}

/** Claude Code: the models that `modelUsage` of the last result object names (its keys); null without a result object. */
export function claudeResultModels(log: string): string[] | null {
  const result = lastObject(log, (object) => object.type === 'result');
  if (result === null) return null;
  return isPlainObject(result.modelUsage) ? Object.keys(result.modelUsage) : [];
}

/** Codex: the `usage` of the last `turn.completed` event. Codex prints no money cost and no turn count. */
export function codexUsage(log: string): PrintedUsage | null {
  const usage = lastObject(log, (object) => object.type === 'turn.completed' && isPlainObject(object.usage))?.usage;
  if (!isPlainObject(usage)) return null;
  return {
    inputTokens: count(usage.input_tokens),
    cachedTokens: count(usage.cached_input_tokens),
    outputTokens: count(usage.output_tokens),
    costUsd: null,
    turns: null,
  };
}

/** Codex: the `thread_id` of the `thread.started` event, the session `codex exec resume` continues; null without one. */
export function codexThreadId(log: string): string | null {
  const id = lastObject(log, (object) => object.type === 'thread.started' && typeof object.thread_id === 'string')?.thread_id;
  return typeof id === 'string' && id !== '' ? id : null;
}

export function printedUsage(cli: AgentCli, log: string): PrintedUsage | null {
  return cli === 'claude-code' ? claudeUsage(log) : codexUsage(log);
}

/**
 * What the runs of a job printed, `logs` holding the output of each run in order (ogw.md `### usage` of `## agent`): the
 * counts and cost the last run printed, the totals of the session, and the sum of the turns of the runs, null when a
 * run printed none; null when the last run printed none.
 */
export function runsUsage(cli: AgentCli, logs: readonly string[]): PrintedUsage | null {
  const printed = logs.map((log) => printedUsage(cli, log));
  const last = printed.at(-1) ?? null;
  if (last === null) return null;
  const turns = printed.reduce<number | null>((sum, run) => (sum === null || run?.turns === null || run?.turns === undefined ? null : sum + run.turns), 0);
  return { ...last, turns };
}

const NONE: PrintedUsage ={ inputTokens: null, cachedTokens: null, outputTokens: null, costUsd: null, turns: null };

export function sessionUsageOf(printed: PrintedUsage): SessionUsage {
  return { inputTokens: printed.inputTokens, cachedTokens: printed.cachedTokens, outputTokens: printed.outputTokens, costUsd: printed.costUsd };
}

/**
 * The usage of the job: what the CLI printed, or for a continued session the printed totals minus `before`, the
 * `sessionUsage` of the job of that session that started last before it (null: none). A value is null when either
 * side lacks it or the difference is negative, and `costUnknown` says why the cost is null.
 */
export function jobUsage(agent: AgentSettings, printed: PrintedUsage | null, resumed: boolean, before: SessionUsage | null): AgentUsage {
  const own: PrintedUsage = { ...(printed ?? NONE) };
  if (printed !== null && resumed) {
    for (const field of SESSION_FIELDS) {
      const total = printed[field];
      const earlier = before?.[field] ?? null;
      const difference = total === null || earlier === null ? null : total - earlier;
      own[field] = difference === null || difference < 0 ? null : difference;
    }
  }
  const cli = agentCli(agent);
  const { turns, ...counts } = own;
  return { cli, model: agent.model, effort: agent.effort, ...counts, costUnknown: costUnknownReason(cli, printed, own.costUsd), turns };
}

/** Why a job has no cost: Codex prints none, the last run printed no usage line with a cost, or the session difference failed. */
function costUnknownReason(cli: AgentCli, printed: PrintedUsage | null, cost: number | null): string | null {
  if (cost !== null) return null;
  if (cli === 'codex') return COST_UNKNOWN.codex;
  return printed === null || printed.costUsd === null ? COST_UNKNOWN.noUsageLine : COST_UNKNOWN.session;
}

/**
 * Why the job of `usage` has no cost: its `costUnknown`, for a usage that an older `ogw` wrote without it the reason
 * the current one gives, and `no usage` without usage. null when it has a cost.
 */
export function costUnknownOf(usage: AgentUsage | null): string | null {
  if (usage === null) return 'no usage';
  if (usage.costUsd !== null) return null;
  return usage.costUnknown ?? (usage.cli === 'codex' ? COST_UNKNOWN.codex : COST_UNKNOWN.noUsageLine);
}

/**
 * `text` (lines of a CLI log) with each Claude Code result object whose `result` is a string replaced with that text,
 * so the failure content shows what the agent last said, as without JSON output.
 */
export function withResultText(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const object = lineObject(line);
      return object !== null && object.type === 'result' && typeof object.result === 'string' ? object.result : line;
    })
    .join('\n');
}
