import { listJobs, type JobRecord } from '../../../lib/jobs.ts';
import { GAME_ROLES } from '../../agent/lib/meta.ts';
import { costUnknownOf, type AgentUsage } from '../../agent/lib/usage.ts';
import { renderTable } from './markdown.ts';

/** `## cost` of the loop iteration record and the loop end record (ogw.md `## loop record`, `## loop end-record`). */

export const COST_COLUMNS = ['role', 'jobs', 'input tokens', 'cached tokens', 'output tokens', 'cost USD', 'without usage', 'without cost'] as const;

/** One row of `## cost`: the jobs of one role, or `total`. */
export interface CostRow {
  role: string;
  jobs: number;
  /** Sums over the jobs that have the value; null when no job has it. */
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** Jobs without `usage` or with a token count of null. */
  withoutUsage: number;
  /** Jobs without `usage` or with a `costUsd` of null. */
  withoutCost: number;
  /** The count of the jobs without cost per reason (`costUnknownOf`), in the order of the reason text. */
  costUnknown: { reason: string; jobs: number }[];
}

const TOKEN_FIELDS = ['inputTokens', 'cachedTokens', 'outputTokens'] as const;

function usageOf(job: JobRecord): AgentUsage | null {
  const usage = job.meta.usage as AgentUsage | undefined;
  return usage ?? null;
}

function sum(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

function rowOf(role: string, jobs: readonly JobRecord[]): CostRow {
  const usages = jobs.map(usageOf);
  const value = (field: (typeof TOKEN_FIELDS)[number] | 'costUsd'): number | null => sum(usages.map((u) => u?.[field] ?? null));
  return {
    role,
    jobs: jobs.length,
    inputTokens: value('inputTokens'),
    cachedTokens: value('cachedTokens'),
    outputTokens: value('outputTokens'),
    costUsd: value('costUsd'),
    withoutUsage: usages.filter((u) => u === null || TOKEN_FIELDS.some((field) => u[field] === null)).length,
    withoutCost: usages.filter((u) => u === null || u.costUsd === null).length,
    costUnknown: reasonCounts(usages.map(costUnknownOf).filter((reason): reason is string => reason !== null)),
  };
}

function reasonCounts(reasons: readonly string[]): CostRow['costUnknown'] {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([reason, jobs]) => ({ reason, jobs }));
}

/** The `without cost` cell: the count, and when it is not 0 the count per reason. */
function withoutCostCell(row: CostRow): string {
  if (row.withoutCost === 0) return '0';
  return `${String(row.withoutCost)} (${row.costUnknown.map((r) => `${r.reason}: ${String(r.jobs)}`).join(', ')})`;
}

/**
 * The rows of `## cost` over `jobs` (`ogw agent` jobs): one per role that has a job, in role order, and with `total`
 * a last row over all of them.
 */
export function costRows(jobs: readonly JobRecord[], total: boolean): CostRow[] {
  const rows = GAME_ROLES.map((role) => rowOf(role, jobs.filter((job) => job.meta.role === role))).filter((row) => row.jobs > 0);
  return total && rows.length > 0 ? [...rows, rowOf('total', jobs)] : rows;
}

function cell(value: number | null, money: boolean): string {
  if (value === null) return 'none';
  return money ? value.toFixed(2) : String(value);
}

export function renderCost(rows: readonly CostRow[]): string {
  if (rows.length === 0) return 'none';
  return renderTable(
    COST_COLUMNS,
    rows.map((row) => [
      row.role,
      String(row.jobs),
      cell(row.inputTokens, false),
      cell(row.cachedTokens, false),
      cell(row.outputTokens, false),
      cell(row.costUsd, true),
      String(row.withoutUsage),
      withoutCostCell(row),
    ]),
  );
}

/** The `ogw agent` jobs of the game in the run, and with `iteration` only those started in that iteration. */
export async function runAgentJobs(env: NodeJS.ProcessEnv, game: string, run: string, iteration: number | null): Promise<JobRecord[]> {
  return (await listJobs(env)).filter(
    (job) =>
      job.command === 'agent' &&
      job.meta.game === game &&
      job.meta.run === run &&
      (iteration === null || job.meta.iteration === iteration),
  );
}
