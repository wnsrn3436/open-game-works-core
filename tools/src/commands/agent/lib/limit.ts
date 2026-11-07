import { readFile } from 'node:fs/promises';
import { whenNotFound } from '../../../lib/fsx.ts';
import type { AgentCli } from './cli-command.ts';
import { agentCliLog } from './meta.ts';
import { withResultText } from './usage.ts';

/**
 * The starts of the limit messages per agent CLI (ogw.md `## loop evaluate` "limit message"): the lines of the limit text
 * that say the usage limit or the rate limit of that CLI was hit. The `’` of `You’ve` in the Codex texts is U+2019.
 */
export const LIMIT_MESSAGE_STARTS: Readonly<Record<AgentCli, readonly string[]>> = {
  'claude-code': [
    "You've hit your ",
    "You've reached your ",
    "You're out of usage credits",
    'Your org is out of usage',
    'API Error: Request rejected (429)',
    'API Error: Server is temporarily limiting requests',
  ],
  codex: [
    'You’ve hit your usage limit',
    'Your workspace is out of credits.',
    'You hit your spend cap',
    'Quota exceeded.',
    'exceeded retry limit, last status: 429 Too Many Requests',
    'rate limit exceeded: ',
  ],
};

/** The `message` of a Codex `error` event, or of the `error` of a `turn.failed` event, on one JSON line; else null. */
function codexEventMessage(line: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    // a line that is not JSON (a stderr line) has no event message
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (typeof value !== 'object' || value === null) return null;
  const event = value as { type?: unknown; message?: unknown; error?: unknown };
  if (event.type === 'error' && typeof event.message === 'string') return event.message;
  const error = event.error as { message?: unknown } | null | undefined;
  if (event.type === 'turn.failed' && typeof error === 'object' && error !== null && typeof error.message === 'string') return error.message;
  return null;
}

/**
 * The limit text of an agent CLI output (ogw.md `## loop evaluate` "limit message"): for Claude Code, each line with a
 * result object replaced by its `result`; for Codex, each line, then the message of each `error` and `turn.failed` event.
 */
export function limitText(cli: AgentCli, output: string): string[] {
  if (cli === 'claude-code') return withResultText(output).split(/\r?\n/);
  const lines = output.split(/\r?\n/);
  return [...lines, ...lines.map(codexEventMessage).filter((m): m is string => m !== null).flatMap((m) => m.split(/\r?\n/))];
}

/** True when a line of the limit text of `output` starts with a limit message of `cli` (a Codex line also after `ERROR: `). */
export function hasLimitMessage(cli: AgentCli, output: string): boolean {
  const starts = LIMIT_MESSAGE_STARTS[cli];
  const prefixes = cli === 'codex' ? ['', 'ERROR: '] : [''];
  return limitText(cli, output).some((line) => starts.some((start) => prefixes.some((prefix) => line.startsWith(prefix + start))));
}

/** True when the agent CLI output of the `ogw agent` job has a limit message of `cli`; false without that output. */
export async function agentHitLimit(id: string, cli: AgentCli, env: NodeJS.ProcessEnv): Promise<boolean> {
  const output = await readFile(await agentCliLog(id, env), 'utf8').catch(whenNotFound(''));
  return hasLimitMessage(cli, output);
}
