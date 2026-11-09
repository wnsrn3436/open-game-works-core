import { join } from 'node:path';
import { parseTokens, type CommandResult, type Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { listJobs, type JobRecord } from '../../../lib/jobs.ts';
import { sideAndTarget } from '../next.ts';
import { run } from '../run.ts';
import type { Side } from './input.ts';
import { lastFixCheck, listTargets, readState, reviewRoot, running, type RoundState } from './state.ts';

export interface TargetStatus {
  target: string;
  round: number;
  /** The result of the last round (`statusResult`), or null with no round. */
  result: string | null;
  /** Ids of the `open` findings of the last judged round whose `spec change` is `yes`. */
  specChange: string[];
  /** The running `ogw review run` job of the target, or null. */
  job: string | null;
}

/** The target of a `ogw review run` job, read from its arguments as the command reads them; null when they do not parse. */
function runTarget(job: JobRecord): string | null {
  try {
    return sideAndTarget(parseTokens(job.argv.slice(2), run.options ?? {}), run.usage).target;
  } catch (error) {
    // arguments that do not parse fail with `OgwError`
    if (error instanceof OgwError) return null;
    throw error;
  }
}

/**
 * The result of the last round (core command.md `## review and code check`): `running` before it or its last fix check
 * is judged, `check fail` when that fix check was judged with a `fail` (as `ogw review wait` gives it), else the round's
 * result.
 */
function statusResult(last: RoundState): string | null {
  if (running(last)) return 'running';
  return lastFixCheck(last)?.result === 'fail' ? 'check fail' : last.result;
}

/** `ogw review status <core|tool>`. */
export async function reviewStatus(ctx: Context, side: Side): Promise<CommandResult> {
  const root = await reviewRoot(ctx, side);
  const runs = side === 'core'
    ? (await listJobs(ctx.env)).filter((job) => job.command === 'review run' && job.status === 'running')
    : [];
  const targets: TargetStatus[] = [];
  for (const target of await listTargets(root)) {
    const rounds = (await readState(join(root, target), side, target)).rounds;
    const last = rounds.at(-1);
    const judged = rounds.filter((r) => r.judged).at(-1);
    targets.push({
      target,
      round: last?.round ?? 0,
      result: last === undefined ? null : statusResult(last),
      specChange: (judged?.open ?? []).filter((f) => f.specChange === 'yes').map((f) => f.id),
      job: runs.find((job) => runTarget(job) === target)?.id ?? null,
    });
  }
  const lines = targets.map((t) =>
    `${t.target} round ${String(t.round)} ${t.result ?? 'none'} spec change: ${t.specChange.join(' ') || 'none'} job: ${t.job ?? 'none'}`);
  return { text: lines.length > 0 ? lines.join('\n') : 'no review state', data: { targets } };
}
