import { expectPositionals, flag, positional, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { revParse } from '../../lib/git.ts';
import { changeOpenRun } from '../../lib/runstate.ts';
import type { IterationKind } from './lib/files.ts';
import { gatePassed, iterationRecords, type ParsedRecord } from './lib/iteration-record.ts';
import { gameSettings, iterationKind, loopData, openTarget, type LoopData } from './lib/run.ts';
import type { RunState } from '../../lib/runstate.ts';
import { gameCoreVersion } from '../core/api.ts';
import { requireHarnessCore } from '../core/lib/harness-core.ts';
import type { JsonObject } from '../../lib/json.ts';
import { currentPinSettings, harnessHead, harnessSettingsOfRun, pinHarness, repinLines, requirePinned, type Repin } from './lib/harness-pin.ts';
import { iterationLimit, iterationLimitLine } from './lib/run-limits.ts';

const USAGE = 'ogw loop next <game> [--repin]';

/** The kind of iteration `n` of the run: the `- kind:` of its record, else the one `ogw loop next` kept. */
function kindOf(run: RunState, records: readonly ParsedRecord[], n: number): IterationKind {
  const record = records.find((r) => r.iteration === n);
  return record === undefined ? iterationKind(run, n) : record.kind;
}

/**
 * The kind of the new iteration `n` (ogw.md `## loop next`): iteration 1 and a confirmation iteration are
 * completeness iterations; so is the iteration after a completeness iteration whose `gate` was `fail` (a record whose
 * gate checks did not all pass, or no record), the iteration after `funIterations` fun iterations in a row, and the
 * iteration after one whose verdict has `success blocked by` (`blocked`).
 */
export function nextKind(run: RunState, records: readonly ParsedRecord[], n: number, confirming: boolean, funIterations: number, blocked = false): IterationKind {
  if (run.kind !== 'loop' || n === 1 || confirming || blocked) return 'completeness';
  const previous = records.find((r) => r.iteration === n - 1);
  if (kindOf(run, records, n - 1) === 'completeness' && (previous === undefined || !gatePassed(previous))) return 'completeness';
  let fun = 0;
  for (let i = n - 1; i >= 1 && kindOf(run, records, i) === 'fun'; i--) fun++;
  return fun >= funIterations ? 'completeness' : 'fun';
}

/**
 * The checks of ogw.md `## loop next` before a loop run raises the number: the iteration limit of the run, and the
 * pinned harness commit against the harness repo HEAD (`harness`). With the run settings of harness settings
 * (`repin`), it repins for the new iteration instead. Returns what the repin changed.
 */
function checkLoopStart(open: RunState, loopIterationLimit: number, harness: string | null, repin: JsonObject | null): Repin | null {
  if (open.kind !== 'loop') return null;
  const reached = iterationLimit(open, loopIterationLimit);
  if (open.iteration >= reached.limit) {
    throw new OgwError(iterationLimitLine(open.iteration, reached), 1, { iteration: open.iteration, limit: reached.limit, by: reached.by });
  }
  if (harness === null) return null;
  if (repin === null) {
    requirePinned(open, harness);
    return null;
  }
  return pinHarness(open, harness, repin, open.iteration + 1);
}

/** True when the verdict of iteration `n` has `success blocked by` (ogw.md `## loop verdict`). */
function blockedAt(data: LoopData | null, n: number): boolean {
  return data?.verdict?.iteration === n && (data.verdict.blockedBy?.length ?? 0) > 0;
}

export const loopNext: CommandDef = {
  name: ['loop', 'next'],
  usage: USAGE,
  options: { repin: { type: 'boolean' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const { game, run } = await openTarget(ctx, positional(args, 0, 'game'));
    if ((await ctx.settings()).useLocalCore) {
      throw new OgwError('harness settings useLocalCore is true: loop iterations do not start while the local core is in use');
    }
    // a harness HEAD that moved away from the pinned commit fails with the pin output first, so the run stays open (ogw.md `## loop next`)
    if (run.kind === 'loop' && !flag(args, 'repin')) requirePinned(run, await harnessHead(ctx.env));
    // the content agent of the iteration reads the specs of this harness
    await requireHarnessCore(ctx, game.name, await gameCoreVersion(game));
    const limit = Number((await gameSettings(ctx, game)).loopIterationLimit);
    const records = await iterationRecords(game, run);
    const harness = run.kind === 'loop' ? await harnessHead(ctx.env) : null;
    const repinTo = harness !== null && flag(args, 'repin') ? await currentPinSettings(ctx) : null;
    // The checks read the run inside the run file lock, so concurrent calls cannot pass the limit or set the reference twice.
    const started = await changeOpenRun(game, async (open) => {
      // the iteration runs on the pinned harness commit; a repin counts for the iteration it starts
      const repinned = checkLoopStart(open, limit, harness, repinTo);
      // the iteration reads the run settings of the pin that counts for it
      const settings = await harnessSettingsOfRun(ctx, open);
      if (open.kind === 'loop' && open.iteration === 0) open.referenceCommit = await revParse(game.root, open.branch, { env: ctx.env });
      // After a `confirm` verdict the new iteration confirms the candidate iteration (ogw.md `## loop verdict`).
      const data = open.kind === 'loop' ? loopData(open) : null;
      const confirming = data !== null && data.verdict?.reason === 'confirm' && data.verdict.iteration === open.iteration;
      const candidate = confirming ? (data.confirms.find((c) => c.iteration === open.iteration)?.candidate ?? open.iteration) : null;
      const kind = nextKind(open, records.filter((r) => r.iteration <= open.iteration), open.iteration + 1, candidate !== null, settings.loop.funIterations, blockedAt(data, open.iteration));
      open.iteration++;
      if (data !== null && candidate !== null) data.confirms.push({ iteration: open.iteration, candidate });
      if (data !== null) data.kinds = [...data.kinds.filter((k) => k.iteration !== open.iteration), { iteration: open.iteration, kind }];
      const variants = open.kind === 'loop' && kind === 'fun' ? settings.loop.variants : null;
      return { iteration: open.iteration, confirms: candidate, kind, repinned, variants };
    });
    const { iteration, confirms, kind, repinned, variants } = started;
    const lines = [
      `iteration ${String(iteration)}`,
      ...(confirms === null ? [] : [`confirms iteration ${String(confirms)}`]),
      `kind: ${kind}`,
      ...(variants === null ? [] : [`variants: ${String(variants)}`]),
      ...repinLines(repinned),
    ];
    const repinData = repinned?.commit ?? null;
    return { text: lines.join('\n'), data: { run: run.name, iteration, confirms, kind, repinned: repinData, runSettingsRepinned: repinned?.units ?? [], variants } };
  },
};
