import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { revParse } from '../../lib/git.ts';
import { changeOpenRun } from '../../lib/runstate.ts';
import type { IterationKind } from './lib/files.ts';
import { gatePassed, iterationRecords, type ParsedRecord } from './lib/iteration-record.ts';
import { gameSettings, iterationKind, loopData, openTarget } from './lib/run.ts';
import type { RunState } from '../../lib/runstate.ts';
import { gameCoreVersion } from '../core/api.ts';
import { requireHarnessCore } from '../core/lib/harness-core.ts';

const USAGE = 'ogw loop next <game>';

/** The kind of iteration `n` of the run: the `- kind:` of its record, else the one `ogw loop next` kept. */
function kindOf(run: RunState, records: readonly ParsedRecord[], n: number): IterationKind {
  const record = records.find((r) => r.iteration === n);
  return record === undefined ? iterationKind(run, n) : record.kind;
}

/**
 * The kind of the new iteration `n` (`game-loop` `## iteration`): iteration 1 and a confirmation iteration are
 * completeness iterations; so is the iteration after a completeness iteration whose `gate` was `fail` (a record whose
 * gate checks did not all pass, or no record) and the iteration after `funIterations` fun iterations in a row.
 */
export function nextKind(run: RunState, records: readonly ParsedRecord[], n: number, confirming: boolean, funIterations: number): IterationKind {
  if (run.kind !== 'loop' || n === 1 || confirming) return 'completeness';
  const previous = records.find((r) => r.iteration === n - 1);
  if (kindOf(run, records, n - 1) === 'completeness' && (previous === undefined || !gatePassed(previous))) return 'completeness';
  let fun = 0;
  for (let i = n - 1; i >= 1 && kindOf(run, records, i) === 'fun'; i--) fun++;
  return fun >= funIterations ? 'completeness' : 'fun';
}

export const loopNext: CommandDef = {
  name: ['loop', 'next'],
  usage: USAGE,
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const { game, run } = await openTarget(ctx, positional(args, 0, 'game'));
    if ((await ctx.settings()).useLocalCore) {
      throw new OgwError('harness settings useLocalCore is true: loop iterations do not start while the local core is in use');
    }
    // the content agent of the iteration reads the specs of this harness
    await requireHarnessCore(ctx, game.name, await gameCoreVersion(game));
    const limit = Number((await gameSettings(ctx, game)).loopIterationLimit);
    const funIterations = (await ctx.settings()).loop.funIterations;
    const records = await iterationRecords(game, run);
    // Both checks read the run inside the run file lock, so concurrent calls cannot pass the limit or set the reference twice.
    const started = await changeOpenRun(game, async (open) => {
      if (open.kind === 'loop' && open.iteration >= limit) {
        throw new OgwError(`iteration ${String(open.iteration)} reached game settings loopIterationLimit ${String(limit)}`, 1, {
          iteration: open.iteration,
          limit,
        });
      }
      if (open.kind === 'loop' && open.iteration === 0) open.referenceCommit = await revParse(game.root, open.branch, { env: ctx.env });
      // After a `confirm` verdict the new iteration confirms the candidate iteration (`game-loop` `## stop`).
      const data = open.kind === 'loop' ? loopData(open) : null;
      const confirming = data !== null && data.verdict?.reason === 'confirm' && data.verdict.iteration === open.iteration;
      const candidate = confirming ? (data.confirms.find((c) => c.iteration === open.iteration)?.candidate ?? open.iteration) : null;
      const kind = nextKind(open, records.filter((r) => r.iteration <= open.iteration), open.iteration + 1, candidate !== null, funIterations);
      open.iteration++;
      if (data !== null && candidate !== null) data.confirms.push({ iteration: open.iteration, candidate });
      if (data !== null) data.kinds = [...data.kinds.filter((k) => k.iteration !== open.iteration), { iteration: open.iteration, kind }];
      return { iteration: open.iteration, confirms: candidate, kind };
    });
    const { iteration, confirms, kind } = started;
    const lines = [`iteration ${String(iteration)}`, ...(confirms === null ? [] : [`confirms iteration ${String(confirms)}`]), `kind: ${kind}`];
    return { text: lines.join('\n'), data: { run: run.name, iteration, confirms, kind } };
  },
};
