import { dirname, join } from 'node:path';
import { agentContext } from '../../../lib/agentctx.ts';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { readRecord } from './records.ts';

/** Folder the running play or judge agent started in, or null when this process belongs to no such agent. */
export async function playAgentFolder(ctx: Context): Promise<string | null> {
  const agent = await agentContext(ctx.env);
  if (!agent || (agent.meta.role !== 'play' && agent.meta.role !== 'judge')) return null;
  const folder = agent.meta.folder;
  if (typeof folder === 'string') return folder;
  return typeof agent.meta.output === 'string' ? dirname(agent.meta.output) : null;
}

/**
 * `captures/` of `ogw capture`, `ogw input --video` and `ogw frames`: in the folder of the play or
 * judge agent, else in the game repo or worktree the instance runs from.
 */
export async function capturesDir(ctx: Context, instanceId: string | null): Promise<string> {
  const folder = await playAgentFolder(ctx);
  if (folder !== null) return join(folder, 'captures');
  if (instanceId === null) throw new OgwError('not defined: the captures folder of ogw frames outside a play or judge agent');
  return join((await readRecord(instanceId, ctx.env)).root, 'captures');
}

/** File name stem of a capture: the instance id and the Unix ms of the capture. */
export function captureStem(instanceId: string, at: number): string {
  return `${instanceId}-${String(at)}`;
}
