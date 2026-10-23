import type { Context } from '../../../lib/command.ts';
import { automationRequest, type ClientRef } from '../../instance/automation.ts';

export interface ClientLogFile {
  path: string;
  /** The byte offset the content starts at (`extract_logs` with offsets); null when the client gave the whole file. */
  offset: number | null;
  content: string;
}

/** A client log or the server log could not be read: what was not read is not a pass (AGENTS.md `## loop`: unknown, not failure). */
export class ClientLogUnreadable extends Error {}

/**
 * Log files of a client (`QACore` `extract_logs`); a file without a string `content` has empty content, and an `ok`
 * answer without a result (`null`) has no files. Throws {@link ClientLogUnreadable} when the command fails, answers
 * something other than a list, or its request throws (a client that hangs or closed its automation channel).
 */
export async function clientLogFiles(ctx: Context, id: string, client: ClientRef, offsets?: ReadonlyMap<string, number>): Promise<ClientLogFile[]> {
  let response: Awaited<ReturnType<typeof automationRequest>>;
  try {
    // with offsets the client sends each file from that byte offset only (`QACore` `extract_logs`)
    response = await automationRequest(ctx, id, 'extract_logs', offsets === undefined ? [] : [JSON.stringify(Object.fromEntries(offsets))], client);
  } catch (error) {
    throw new ClientLogUnreadable(`client ${client} log could not be read: extract_logs failed: ${(error as Error).message}`);
  }
  if (response.ok && response.result === null) return [];
  if (!response.ok || !Array.isArray(response.result)) {
    throw new ClientLogUnreadable(`client ${client} log could not be read: extract_logs returned ${JSON.stringify(response.result)}`);
  }
  return (response.result as unknown[]).map((file) => {
    const { path, offset, content } = (file ?? {}) as { path?: unknown; offset?: unknown; content?: unknown };
    return {
      path: typeof path === 'string' ? path : '',
      offset: typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 ? offset : null,
      content: typeof content === 'string' ? content : '',
    };
  });
}

/** Text of all log files of a client (`QACore` `extract_logs`); throws {@link ClientLogUnreadable} as `clientLogFiles` does. */
export async function clientLog(ctx: Context, id: string, client: ClientRef): Promise<string> {
  return (await clientLogFiles(ctx, id, client)).map((file) => file.content).join('');
}

/** `error` lines of a client log (`LogCore` log line: time, level, tag, message, stack_trace joined by tab). */
export function clientErrorLines(log: string): string[] {
  return log.split('\n').filter((line) => line.split('\t')[1] === 'error');
}

/** `error` lines of a server log (`server-core` `## log`: one JSON object per line). */
export function serverErrorLines(log: string): string[] {
  return log.split('\n').filter((line) => {
    if (line.trim() === '') return false;
    try {
      return (JSON.parse(line) as { level?: unknown }).level === 'error';
    } catch {
      return false;
    }
  });
}
