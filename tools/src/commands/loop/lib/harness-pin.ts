import { isDeepStrictEqual } from 'node:util';
import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import { head } from '../../../lib/git.ts';
import { isPlainObject, valueUnits, type JsonObject } from '../../../lib/json.ts';
import { harnessRoot } from '../../../lib/paths.ts';
import { openRun, type RunState } from '../../../lib/runstate.ts';
import { currentRunSettings, loadHarnessSettings, type HarnessSettings } from '../../../lib/settings.ts';

/** The pins of a loop run: its pinned harness commit and run settings, and their repins (ogw.md `## loop start`, `## loop next`). */

/** `run.data` key of the pins of the run, in pin order. */
export const HARNESS_PINS_KEY = 'harness pins';

export interface HarnessPin {
  commit: string;
  /** The iteration the pin counts for: 0 for the pin of `ogw loop start`. */
  iteration: number;
  /** The run settings of the pin (ogw.md `## loop start`); absent in a pin that holds none. */
  runSettings?: JsonObject;
}

export function harnessPins(run: RunState): HarnessPin[] {
  const value = run.data[HARNESS_PINS_KEY];
  return Array.isArray(value) ? (value as HarnessPin[]) : [];
}

/** The pinned harness commit of the run; null for a run without one (a build run). */
export function pinnedHarness(run: RunState): string | null {
  return harnessPins(run).at(-1)?.commit ?? null;
}

export async function harnessHead(env: NodeJS.ProcessEnv): Promise<string> {
  return head(harnessRoot(env), { env });
}

/** The run settings of the last pin of the run; null when it holds none (a build run, a pin without them). */
export function pinnedRunSettings(run: RunState): JsonObject | null {
  const settings = harnessPins(run).at(-1)?.runSettings;
  return isPlainObject(settings) ? settings : null;
}

/** What a repin changed: the commit before and after when the commit changed, and the units of the run settings whose value changed. */
export interface Repin {
  commit: { from: string; to: string } | null;
  units: string[];
}

function valueAt(value: unknown, unit: readonly string[]): unknown {
  let current = value;
  for (const segment of unit) current = isPlainObject(current) ? current[segment] : undefined;
  return current;
}

/** The units (`valueUnits`) of run settings whose value differs between `before` and `after`, in the order of `after` then `before`. */
export function changedRunUnits(before: JsonObject | null, after: JsonObject | null): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const unit of [...valueUnits(after ?? {}), ...valueUnits(before ?? {})]) {
    const key = JSON.stringify(unit);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isDeepStrictEqual(valueAt(before, unit), valueAt(after, unit))) out.push(unit);
  }
  return out;
}

/**
 * Pins `commit` and `runSettings` for `iteration` (ogw.md `## loop next`): a new pin when either differs from the last
 * pin. Returns what the new pin changed, or null when there is none.
 */
export function pinHarness(run: RunState, commit: string, runSettings: JsonObject, iteration: number): Repin | null {
  const pins = harnessPins(run);
  const last = pins.at(-1);
  const before = pinnedRunSettings(run);
  if (last !== undefined && last.commit === commit && isDeepStrictEqual(before, runSettings)) return null;
  run.data[HARNESS_PINS_KEY] = [...pins, { commit, iteration, runSettings }];
  return {
    commit: last !== undefined && last.commit !== commit ? { from: last.commit, to: commit } : null,
    units: last === undefined ? [] : changedRunUnits(before, runSettings).map((unit) => unit.join('.')),
  };
}

/** The output lines of a repin (ogw.md `## loop next`), each followed by `suffix`. */
export function repinLines(repin: Repin | null, suffix = ''): string[] {
  if (repin === null) return [];
  return [
    ...(repin.commit === null ? [] : [`harness: ${repin.commit.to} (repinned from ${repin.commit.from})${suffix}`]),
    ...(repin.units.length === 0 ? [] : [`run settings: ${repin.units.join(', ')} (repinned)${suffix}`]),
  ];
}

/** The run settings of harness settings now, which a pin records (ogw.md `## loop start`). */
export function currentPinSettings(ctx: Context): Promise<JsonObject> {
  return currentRunSettings(ctx.env);
}

/**
 * Harness settings for a command of the open run `run` (ogw.md `## loop start`): in a loop run whose last pin holds
 * run settings, the run paths hold those values; otherwise harness settings.
 */
export function harnessSettingsOfRun(ctx: Context, run: RunState | null): Promise<HarnessSettings> {
  const pinned = run?.kind === 'loop' ? pinnedRunSettings(run) : null;
  return pinned === null ? ctx.settings() : loadHarnessSettings(ctx.env, pinned);
}

/** Harness settings for a command that works on `game` (`harnessSettingsOfRun` of its open run). */
export async function runHarnessSettings(ctx: Context, game: GameRepo): Promise<HarnessSettings> {
  return harnessSettingsOfRun(ctx, await openRun(game));
}

/** Fails, naming both commits, when the run has a pinned harness commit that is not the harness repo HEAD. */
export function requirePinned(run: RunState, harnessHeadCommit: string): void {
  const pinned = pinnedHarness(run);
  if (pinned === null || pinned === harnessHeadCommit) return;
  throw new OgwError(
    `harness repo HEAD ${harnessHeadCommit} is not the pinned harness commit ${pinned} of run ${run.name}: give --repin to pin ${harnessHeadCommit}`,
    1,
    { pinned, harnessHead: harnessHeadCommit },
  );
}

/**
 * The `- harness:` value of iteration `n` (ogw.md `## loop record`): the commit of the last pin that counts for `n` or an
 * earlier iteration, with the commit of iteration `n - 1` when a repin that changed the commit counts for `n`. A run
 * without a pin (a build run) gives `harnessHeadCommit`.
 */
export function harnessLine(run: RunState, n: number, harnessHeadCommit: string): string {
  const pins = harnessPins(run);
  if (pins.length === 0) return harnessHeadCommit;
  const commitOf = (iteration: number): string | null => pins.filter((p) => p.iteration <= iteration).at(-1)?.commit ?? null;
  const commit = commitOf(n) ?? 'none';
  const before = n >= 1 ? commitOf(n - 1) : null;
  const repinned = before !== null && before !== commit && pins.some((p) => p.iteration === n);
  return repinned ? `${commit} (repinned from ${before})` : commit;
}

/**
 * The lines of `## run settings` of ogw.md `## loop end-record`: per pin with run settings that differ from those of the
 * pin before it, its iteration and the units of its run settings, all for the first such pin and the changed ones after.
 */
export function runSettingsLines(run: RunState): string[] {
  const lines: string[] = [];
  let before: JsonObject | null = null;
  for (const pin of harnessPins(run)) {
    if (!isPlainObject(pin.runSettings)) continue;
    const after = pin.runSettings;
    const units = before === null ? valueUnits(after) : changedRunUnits(before, after);
    before = after;
    if (units.length === 0) continue;
    lines.push(`- iteration ${String(pin.iteration)}:`);
    for (const unit of units) {
      const value = valueAt(after, unit);
      lines.push(`  - ${unit.join('.')}: ${value === undefined ? 'none' : JSON.stringify(value)}`);
    }
  }
  return lines;
}
