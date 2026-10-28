import { join } from 'node:path';
import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, writeFileAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { LIMITS } from '../../lib/limits.ts';
import type { HarnessSettings } from '../../lib/settings.ts';
import { elementsOf, type JudgeEntry } from '../loop/lib/files.ts';
import {
  alternateSide,
  drawSide,
  evaluateDeps,
  judgeAgent,
  judgeGroup,
  runJudging,
  type EvaluateSite,
  type Group,
  type JudgePair,
  type JudgingPlan,
} from '../loop/lib/evaluate.ts';
import { countVotes } from '../loop/lib/votes.ts';
import { missingLoginToken } from '../secret/lib/login-token.ts';
import { commitOnMain, prepareMain } from './lib/guard.ts';
import { CALIBRATION_DIR, hasCommit, judgedPairs, readLabels } from './lib/pairs.ts';
import { rateLines, rates, recommendations, renderReport, type CalibrationPair, type PairOutcome } from './lib/report.ts';

const USAGE = 'ogw judge calibrate <game>';

/** The judge input `elements` of a fun iteration, which every calibration judge gets. */
const ELEMENTS = elementsOf('fun');

/** The pairs of judge calibration, in report order (`game-loop` `## judge calibration`). */
async function calibrationPairs(ctx: Context, game: GameRepo, main: string, settings: HarnessSettings): Promise<CalibrationPair[]> {
  const votes = settings.loop.judgeVotes;
  const pair = (name: string, kind: CalibrationPair['kind'], commit: string, baseline: string, rest: Partial<CalibrationPair> = {}): CalibrationPair => ({
    name,
    kind,
    commit,
    baseline,
    baselineLatencyMs: 0,
    judges: votes,
    first: drawSide(),
    label: null,
    missing: null,
    ...rest,
  });
  const pairs: CalibrationPair[] = [];
  for (let n = 1; n <= settings.calibration.nullPairs; n++) pairs.push(pair(`null-${String(n)}`, 'null', main, main));
  const order = (await judgedPairs(game.root, ctx.env))[0];
  if (order !== undefined) pairs.push(pair('order', 'order', order.commit, order.baseline, { judges: 2 * settings.calibration.orderRuns, first: 'A' }));
  pairs.push(pair('degraded', 'degraded', main, main, { baselineLatencyMs: settings.calibration.degradeLatencyMs }));
  const labels = await readLabels(game.root);
  labels.forEach((label, i) => pairs.push(pair(`label-${String(i + 1)}`, 'label', label.A, label.B, { label })));
  for (const p of pairs) {
    for (const commit of [p.commit, p.baseline]) if (p.missing === null && !(await hasCommit(game.root, commit, ctx.env))) p.missing = commit;
  }
  return pairs;
}

/** The files of a calibration: judge results in `records/calibration/<ms>/`, the rest in `builds/calibration/<ms>/`. */
function calibrationSite(root: string, ms: string): EvaluateSite {
  const records = join(root, CALIBRATION_DIR, ms);
  const builds = join(root, 'builds', 'calibration', ms);
  return {
    input: (role, at) => join(builds, `input-${role}-${String(at)}.json`),
    telemetry: (pair, k) => join(builds, `telemetry-${pair.name}-${String(k)}.md`),
    measure: (instance) => join(builds, `measure-${instance}.json`),
    judgePlace: (pair, k) => ({ output: join(records, `judge-${pair.name}-${String(k)}.md`), evidence: join(builds, `judge-${pair.name}-${String(k)}`) }),
  };
}

/** One judge group per judge of each pair that is judged; the judge pairs by calibration pair. */
function groupsOf(plan: JudgingPlan, pairs: readonly CalibrationPair[]): { groups: Group[]; judgePairs: Map<JudgePair, CalibrationPair> } {
  const groups: Group[] = [];
  const judgePairs = new Map<JudgePair, CalibrationPair>();
  for (const p of pairs.filter((x) => x.missing === null)) {
    const judgePair: JudgePair = { name: p.name, commit: p.commit, baseline: p.baseline, baselineLatencyMs: p.baselineLatencyMs };
    judgePairs.set(judgePair, p);
    for (let k = 1; k <= p.judges; k++) groups.push(judgeGroup(plan, judgePair, 'main', k, alternateSide(p.first, k), judgeAgent(plan.settings, k)));
  }
  return { groups, judgePairs };
}

/** The outcome of each pair: counted when every judge is `done`, with its element decisions over its judges. */
function outcomesOf(pairs: readonly CalibrationPair[], judged: Map<CalibrationPair, { k: number; entry: JudgeEntry }[]>): PairOutcome[] {
  return pairs.map((pair) => {
    if (pair.missing !== null) return { pair, judges: [], status: 'not judged', votes: null };
    const judges = (judged.get(pair) ?? []).sort((a, b) => a.k - b.k);
    const done = judges.length === pair.judges && judges.every((j) => j.entry.status === 'done');
    return { pair, judges, status: done ? 'counted' : 'not counted', votes: done ? countVotes(judges.map((j) => j.entry), ELEMENTS, pair.judges) : null };
  });
}

/**
 * `ogw judge calibrate <game>` (`game-loop` `## judge calibration`): judges the null pairs, the order pair, the degraded
 * pair and the labeled pairs with the judges of a fun iteration, and writes and commits the report on main.
 */
export const judgeCalibrate: CommandDef = {
  name: ['judge', 'calibrate'],
  usage: USAGE,
  background: {
    game: (args) => args.positionals[0] ?? null,
    timeLimitMs: () => LIMITS.jobMs,
  },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const game = await ctx.game(positional(args, 0, 'game'));
    const settings = await ctx.settings();
    const tokenMissing = missingLoginToken(ctx, settings);
    if (tokenMissing !== null) throw new OgwError(tokenMissing);
    const main = await prepareMain(ctx, game);
    const ms = String(evaluateDeps.now());
    const pairs = await calibrationPairs(ctx, game, main, settings);
    const plan: JudgingPlan = { game, kind: 'fun', moments: [], reference: null, settings, db: undefined, site: calibrationSite(game.root, ms) };
    const { groups, judgePairs } = groupsOf(plan, pairs);
    const slots = await runJudging(ctx, plan, groups);
    const judged = new Map<CalibrationPair, { k: number; entry: JudgeEntry }[]>();
    for (const slot of slots) {
      const pair = slot.role === 'judge' ? judgePairs.get(slot.pair) : undefined;
      if (slot.role !== 'judge' || pair === undefined || slot.entry === null) continue;
      judged.set(pair, [...(judged.get(pair) ?? []), { k: slot.k, entry: slot.entry }]);
    }
    const outcomes = outcomesOf(pairs, judged);
    const result = rates(outcomes, ELEMENTS, pairs.filter((p) => p.kind === 'label').length);
    const report = `${CALIBRATION_DIR}/${ms}.md`;
    await writeFileAtomic(join(game.root, report), renderReport(outcomes, ELEMENTS, result, settings.loop.judgeVotes));
    const results = outcomes.flatMap((o) => o.judges.map((j) => j.entry.result)).filter((r) => r !== '' && exists(join(game.root, r)));
    await commitOnMain(ctx, game, [report, ...results], `judge calibration ${ms}`);
    const lines = [report, ...rateLines(result), ...recommendations(result, settings.loop.judgeVotes).map((r) => `recommendation: ${r}`)];
    return { text: lines.join('\n'), data: { report, outcomes: outcomes.map((o) => ({ pair: o.pair.name, status: o.status, votes: o.votes })), rates: result } };
  },
};
