import type { Context } from '../../lib/command.ts';
import type { AgentSettings, Role } from '../../lib/settings.ts';
import { mergeAgents, type MergeFailure } from './lib/merge.ts';
import { outcomeOf } from './lib/outcome.ts';
import { startAgent, type CalibrationPlace } from './lib/prepare.ts';

export type { CalibrationPlace } from './lib/prepare.ts';
import { retryAgent } from './lib/retry.ts';

export { agentCliCommand, agentSettings, sandboxed } from './lib/cli-command.ts';
export { agentMeta, readAgentJob, type AgentMeta } from './lib/meta.ts';

export interface AgentJobOptions {
  role: Role;
  /** Required for every role except `core` and `review`. */
  game?: string;
  input: string;
  modules?: string[];
  /** The agent CLI, model and effort instead of harness settings `agents.<role>`. */
  agent?: AgentSettings;
  /** judge of `ogw judge calibrate`: no run; the result file and the evidence folder under the calibration folders. */
  calibration?: CalibrationPlace;
}

/** Starts `ogw agent <role> ... --background` and returns the job id. */
export function startAgentJob(ctx: Context, options: AgentJobOptions): Promise<string> {
  return startAgent(ctx, options);
}

export interface AgentOutcome {
  status: 'running' | 'done' | 'failed';
  /** Absolute path of the result file when the agent wrote it, else null. */
  output: string | null;
}

/** Status of an agent job; an agent that ended without a result file is `failed`. */
export function agentOutcome(ctx: Context, id: string): Promise<AgentOutcome> {
  return outcomeOf(id, ctx.env);
}

export interface MergeOutcome {
  merged: string[];
  failed: MergeFailure[];
}

/** `ogw agent merge <id>...`. A failure `reason` is `conflict`, `data`, or why the job cannot be merged. */
export function mergeAgentJobs(ctx: Context, ids: string[]): Promise<MergeOutcome> {
  return mergeAgents(ctx, ids);
}

/** `ogw agent retry <id> --background`; returns the new job id. */
export function retryAgentJob(ctx: Context, id: string): Promise<string> {
  return retryAgent(ctx, id);
}
