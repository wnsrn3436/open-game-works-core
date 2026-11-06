import { readFile } from 'node:fs/promises';
import type { AgentCli } from './cli-command.ts';
import { agentCliLog } from './meta.ts';

/**
 * The starts of the limit messages per agent CLI (ogw.md `## loop evaluate` "limit message"): the lines that say the
 * usage limit or the rate limit of that CLI was hit. Claude Code (`claude -p`) prints the message as its result line;
 * `codex exec` prints `ERROR: ` and the message on stderr, with U+2019 in `You’ve`.
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
    'ERROR: You’ve hit your usage limit',
    'ERROR: Your workspace is out of credits.',
    'ERROR: You hit your spend cap',
    'ERROR: Quota exceeded.',
    'ERROR: exceeded retry limit, last status: 429 Too Many Requests',
    'ERROR: rate limit exceeded: ',
  ],
};

/** True when a line of `output` starts with a limit message of `cli`. */
export function hasLimitMessage(cli: AgentCli, output: string): boolean {
  const starts = LIMIT_MESSAGE_STARTS[cli];
  return output.split(/\r?\n/).some((line) => starts.some((start) => line.startsWith(start)));
}

/** True when the agent CLI output of the `ogw agent` job has a limit message of `cli`; false without that output. */
export async function agentHitLimit(id: string, cli: AgentCli, env: NodeJS.ProcessEnv): Promise<boolean> {
  const output = await readFile(await agentCliLog(id, env), 'utf8').catch(() => '');
  return hasLimitMessage(cli, output);
}
