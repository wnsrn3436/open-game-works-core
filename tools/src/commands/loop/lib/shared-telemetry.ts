import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { readJsonIfExists } from '../../../lib/fsx.ts';
import { showFile } from '../../../lib/git.ts';
import type { RunState } from '../../../lib/runstate.ts';
import { SCENARIO } from '../../check/lib/bot-playtest.ts';
import { parseScenario, runScenario, type Scenario } from '../../check/lib/scenario.ts';
import { readTelemetry } from '../../telemetry/api.ts';
import { compareRepeatedTelemetry, failureIsNone, formatComparison, freeScenes } from '../../telemetry/lib/compare.ts';
import type { Telemetry } from '../../telemetry/lib/metrics.ts';

/**
 * The shared telemetry runs of ogw.md `## loop evaluate`: per commit, bot runs of the scenario on headless instances of
 * this commit and of the baseline game commit, the same inputs on all of them.
 */

/** Runs of the scenario per commit: the spread between them is the noise a difference must exceed. */
export const SHARED_TELEMETRY_RUNS = 3;
/** New runs per commit that may replace runs that did not reach every step. */
export const SHARED_TELEMETRY_RETRIES = 3;

/** The telemetry of one bot run and the `play-guide.md` text of its instance (null when it has none). */
export interface BotRun {
  telemetry: Telemetry;
  guide: string | null;
}

/** The scenario of the shared telemetry runs and the SHA-256 (hex) of its file. */
export interface SharedScenario {
  scenario: Scenario;
  sha256: string;
}

/** `client/dev/bot/scenario.json` of the checkout HEAD with the SHA-256 of its bytes; null when it is missing or has another form. */
export async function scenarioAtHead(game: GameRepo, env: NodeJS.ProcessEnv): Promise<SharedScenario | null> {
  const bytes = await showFile(game.root, 'HEAD', SCENARIO, { env });
  if (bytes === null) return null;
  const scenario = parseScenario(bytes.toString('utf8'));
  return typeof scenario === 'string' ? null : { scenario, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** The side of a pair of commits whose runs a bot run is: this commit or the baseline game commit. */
export type RunSide = 'commit' | 'baseline';

/** The shared telemetry runs of the two commits of a pair; a side is null when fewer than `SHARED_TELEMETRY_RUNS` of its runs reached every step. */
export type PairRuns = Record<RunSide, BotRun[] | null>;

/**
 * The shared telemetry runs of a pair (ogw.md `## loop evaluate`): `SHARED_TELEMETRY_RUNS` runs of each side at once,
 * then, per side, new runs one at a time in place of those that did not reach every step, up to
 * `SHARED_TELEMETRY_RETRIES`. `runOnce` makes one run on a new instance (null when it did not reach every step);
 * `between` runs after each wait, and a stop it throws ends the runs.
 */
export async function pairRuns(runOnce: (side: RunSide) => Promise<BotRun | null>, between: () => void = () => undefined): Promise<PairRuns> {
  const sides: RunSide[] = ['commit', 'baseline'];
  const first = await Promise.all(Array.from({ length: SHARED_TELEMETRY_RUNS }, () => sides.map((side) => runOnce(side))).flat());
  between();
  const complete = async (side: RunSide, k: number): Promise<BotRun[] | null> => {
    const runs = first.filter((r, i): r is BotRun => i % 2 === k && r !== null);
    for (let retry = 0; runs.length < SHARED_TELEMETRY_RUNS && retry < SHARED_TELEMETRY_RETRIES; retry++) {
      const run = await runOnce(side);
      between();
      if (run !== null) runs.push(run);
    }
    return runs.length === SHARED_TELEMETRY_RUNS ? runs : null;
  };
  const [commit, baseline] = await Promise.all([complete('commit', 0), complete('baseline', 1)]);
  between();
  return { commit, baseline };
}

/** `telemetry-runs.json` of `ogw check --loop` (ogw.md `## check`): the shared telemetry runs of this commit and the baseline game commit. */
export interface CheckTelemetryRuns {
  commit: string;
  baseline: string;
  /** SHA-256 of the scenario file the runs ran. */
  scenario: string;
  runs: PairRuns;
}

/** The path of `telemetry-runs.json` of iteration `n` in the check evidence folder, relative to the game repo. */
export function telemetryRunsRel(run: Pick<RunState, 'name'>, n: number): string {
  return `records/loops/${run.name}/evidence/check-${String(n)}/telemetry-runs.json`;
}

/** A run of `telemetry-runs.json`: an object whose `telemetry` is an object. */
function isRun(value: unknown): value is BotRun {
  if (typeof value !== 'object' || value === null) return false;
  const telemetry: unknown = (value as Record<string, unknown>).telemetry;
  return typeof telemetry === 'object' && telemetry !== null;
}

function isRuns(value: unknown): value is BotRun[] | null {
  return value === null || (Array.isArray(value) && value.length === SHARED_TELEMETRY_RUNS && value.every(isRun));
}

/**
 * The runs of `telemetry-runs.json` of iteration `n` when the file names `commit`, `baseline` and the scenario
 * `sha256`; null when there is no such file, or it names other commits or another scenario, or has another form.
 */
export async function checkTelemetryRuns(game: GameRepo, run: Pick<RunState, 'name'>, n: number, want: Omit<CheckTelemetryRuns, 'runs'>): Promise<PairRuns | null> {
  const file = await readJsonIfExists(join(game.root, telemetryRunsRel(run, n))).catch(() => null);
  if (typeof file !== 'object' || file === null) return null;
  const { commit, baseline, scenario, runs } = file as Record<string, unknown>;
  if (commit !== want.commit || baseline !== want.baseline || scenario !== want.scenario) return null;
  if (typeof runs !== 'object' || runs === null) return null;
  const sides = runs as Record<string, unknown>;
  if (!isRuns(sides.commit) || !isRuns(sides.baseline)) return null;
  return { commit: sides.commit, baseline: sides.baseline };
}

/**
 * Runs the scenario on the instance up to its last step or its first failed step and reads the telemetry of its
 * client. null when the run did not reach every step, or its telemetry could not be read.
 */
export async function botRun(ctx: Context, instance: { id: string; root: string }, scenario: Scenario, pollMs: number): Promise<BotRun | null> {
  try {
    const outcome = await runScenario(ctx, instance.id, scenario, { pollMs });
    if (outcome.stop !== null && outcome.stop.step < scenario.steps.length) return null;
    const telemetry = await readTelemetry(ctx, instance.id);
    const guide = await readFile(join(instance.root, 'play-guide.md'), 'utf8').catch(() => null);
    return { telemetry, guide };
  } catch {
    return null;
  }
}

/**
 * The run as the player meets it when the runner held each input `latencyMs` (`ogw instance start --input-latency`):
 * the client measures `input_latency_ms` from when it gets the input, so the held time is added to every measured one.
 */
export function withInputLatency(run: BotRun, latencyMs: number): BotRun {
  if (latencyMs <= 0) return run;
  const inputs = run.telemetry.inputs.map((i) => (i.latency_ms === null ? i : { ...i, latency_ms: i.latency_ms + latencyMs }));
  return { ...run, telemetry: { ...run.telemetry, inputs } };
}

/** The `ogw telemetry compare` output of the runs of `A` and of `B`, each side run the same number of times. */
export function comparisonText(a: readonly BotRun[], b: readonly BotRun[]): string {
  const guides = [...a, ...b].map((r) => r.guide);
  const noFailure = guides.some((guide) => guide !== null && failureIsNone(guide));
  const free = (guide: string | null) => (guide === null ? null : freeScenes(guide));
  const first = (runs: readonly BotRun[]) => (runs[0] as BotRun).guide;
  return `${formatComparison(compareRepeatedTelemetry(a.map((r) => r.telemetry), b.map((r) => r.telemetry), noFailure, free(first(a)), free(first(b))))}\n`;
}
