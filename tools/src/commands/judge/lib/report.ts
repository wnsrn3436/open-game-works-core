import type { ElementDecision, ElementVotes, JudgeEntry } from '../../loop/lib/files.ts';
import { document, renderTable, section } from '../../loop/lib/markdown.ts';
import { sensitivityName, type Degradation } from './degradations.ts';
import { kappa } from './kappa.ts';
import type { Answer, LabelEntry } from './pairs.ts';

/** The kinds of pairs of judge calibration (ogw.md `## judge calibrate`). */
export type PairKind = 'null' | 'order' | 'retest' | 'degraded' | 'label';

/** A pair to judge: its `this` and `baseline` commits, its judges and how their sides go. */
export interface CalibrationPair {
  /** `null-<n>`, `order-<n>`, `retest-<n>`, `degraded-<degradation>-<n>`, `label-<n>`. */
  name: string;
  kind: PairKind;
  commit: string;
  baseline: string;
  /** `--input-latency` of the baseline instances; 0 for none. */
  baselineLatencyMs: number;
  /** `--network-delay` of the baseline instances; 0 for none. */
  baselineNetworkDelayMs: number;
  /** `--feedback-off` of the baseline instances. */
  baselineFeedbackOff: boolean;
  /** `--reward-presentation-off` of the baseline instances. */
  baselineRewardPresentationOff: boolean;
  /** The number of judges of each judging, in order: two judgings for a retest pair, one for every other pair. */
  judgings: number[];
  /** The side of `this` of the first judge; the sides alternate. */
  first: 'A' | 'B';
  /** The degradation of a degraded pair; null for every other pair. */
  degradation: Pick<Degradation, 'name' | 'element'> | null;
  label: LabelEntry | null;
  /** The commit of the pair that is not in the game repo; null when both are. */
  missing: string | null;
}

/** The number of judges of a pair: those of all its judgings. */
export function judgeCount(pair: Pick<CalibrationPair, 'judgings'>): number {
  return pair.judgings.reduce((sum, n) => sum + n, 0);
}

/** The k of the k-th judge of a pair (k from 1) in its judging, counted from 1 in each judging. */
export function kInJudging(judgings: readonly number[], k: number): number {
  let rest = k;
  for (const size of judgings) {
    if (rest <= size) return rest;
    rest -= size;
  }
  return rest;
}

/** A judge of a pair as it ended. */
export interface PairJudge {
  k: number;
  entry: JudgeEntry;
}

export type PairStatus = 'counted' | 'not counted' | 'not judged';

/** A pair with its judges, its status and, for a counted pair, the votes and element decisions of each judging. */
export interface PairOutcome {
  pair: CalibrationPair;
  judges: PairJudge[];
  status: PairStatus;
  judgings: ElementVotes[][] | null;
}

/** A share: `count` of `total`. */
export interface Rate {
  count: number;
  total: number;
}

/** A value of order consistency or retest agreement: `all` or an element, with its kappa (null: `undefined`). */
export interface KappaValue {
  name: string;
  rate: Rate;
  kappa: number | null;
}

/** A value of sensitivity: `all` or `<degradation> (<target element>)`. */
export interface SensitivityValue {
  name: string;
  rate: Rate;
}

export interface Rates {
  falseWin: Rate;
  order: KappaValue[];
  retest: KappaValue[];
  sensitivity: SensitivityValue[];
  /** Per element of `elements`. */
  agreement: { element: string; rate: Rate }[];
  labels: number;
  /** Harness settings `calibration.minDecisions`: the smallest total of a value that counts. */
  minDecisions: number;
}

/** Whether a value counts: its total is at least the minimum. */
export function countsRate(rate: Rate, minDecisions: number): boolean {
  return rate.total >= minDecisions;
}

/** `<value rounded to two decimals> (<count> of <total>)`, or `none (<total> of <minimum>)` for a value that does not count. */
export function formatRate(rate: Rate, minDecisions: number): string {
  if (!countsRate(rate, minDecisions)) return `none (${String(rate.total)} of ${String(minDecisions)})`;
  return `${(rate.count / rate.total).toFixed(2)} (${String(rate.count)} of ${String(rate.total)})`;
}

/** `kappa <value>`, `kappa undefined`, or `kappa none` when its value does not count. */
export function formatKappa(value: KappaValue, minDecisions: number): string {
  if (!countsRate(value.rate, minDecisions)) return 'kappa none';
  return value.kappa === null ? 'kappa undefined' : `kappa ${value.kappa.toFixed(2)}`;
}

function counted(outcomes: readonly PairOutcome[], kind: PairKind): PairOutcome[] {
  return outcomes.filter((o) => o.pair.kind === kind && o.status === 'counted' && o.judgings !== null);
}

/** The element decision of the first judging of a counted pair; undefined for an element it has not. */
function decisionOf(outcome: PairOutcome, element: string, judging = 0): ElementDecision | undefined {
  return outcome.judgings?.[judging]?.find((v) => v.element === element)?.decision;
}

/** False win rate: the share of the element decisions of the counted null pairs that are `this` or `baseline`. */
export function falseWinRate(outcomes: readonly PairOutcome[]): Rate {
  const decisions = counted(outcomes, 'null').flatMap((o) => (o.judgings?.[0] ?? []).map((v) => v.decision));
  return { count: decisions.filter((d) => d === 'this' || d === 'baseline').length, total: decisions.length };
}

/** An item of order consistency or retest agreement: an element of a counted pair, whether it agrees, and its ratings. */
export interface AgreementItem {
  element: string;
  same: boolean;
  ratings: string[];
}

/** The rating of a judge's vote for an element: `this`, `baseline` or `no vote`. */
function voteRating(judge: PairJudge, element: string): string {
  return judge.entry.votes?.[element] ?? 'no vote';
}

/** The side vote of a side assignment: the vote every judge of it gave the element, or `mixed`. */
function sideVote(judges: readonly PairJudge[], side: 'A' | 'B', element: string): string {
  const votes = new Set(judges.filter((j) => j.entry.instanceSide === side).map((j) => voteRating(j, element)));
  if (votes.size !== 1) return 'mixed';
  return [...votes][0] as string;
}

/** The order items: an element of a counted order pair agrees when its side vote is the same for both side assignments and not `mixed`. */
export function orderItems(outcomes: readonly PairOutcome[], elements: readonly string[]): AgreementItem[] {
  return counted(outcomes, 'order').flatMap((o) => {
    const judges = [...o.judges].sort((a, b) => a.k - b.k);
    return elements.map((element) => {
      const a = sideVote(judges, 'A', element);
      return { element, same: a !== 'mixed' && a === sideVote(judges, 'B', element), ratings: judges.map((j) => voteRating(j, element)) };
    });
  });
}

/** The retest items: an element of a counted retest pair agrees when its element decisions in the two judgings are the same. */
export function retestItems(outcomes: readonly PairOutcome[], elements: readonly string[]): AgreementItem[] {
  return counted(outcomes, 'retest').flatMap((o) =>
    elements.map((element) => {
      const ratings = [decisionOf(o, element, 0) ?? 'none', decisionOf(o, element, 1) ?? 'none'];
      return { element, same: ratings[0] === ratings[1], ratings };
    }),
  );
}

/** The value `all` over every item and one value per element over its items, each with its kappa. */
export function agreementValues(items: readonly AgreementItem[], elements: readonly string[]): KappaValue[] {
  const value = (name: string, of: readonly AgreementItem[]): KappaValue => ({
    name,
    rate: { count: of.filter((i) => i.same).length, total: of.length },
    kappa: kappa(of.map((i) => i.ratings)),
  });
  return [value('all', items), ...elements.map((element) => value(element, items.filter((i) => i.element === element)))];
}

/**
 * Sensitivity: the value `all` over every counted degraded pair and one value per degradation, each the share of
 * its counted degraded pairs whose element decision of the target element of their degradation is `this`.
 */
export function sensitivity(outcomes: readonly PairOutcome[], degradations: readonly Pick<Degradation, 'name' | 'element'>[]): SensitivityValue[] {
  const degraded = counted(outcomes, 'degraded');
  const rate = (of: readonly PairOutcome[]): Rate => ({
    count: of.filter((o) => o.pair.degradation !== null && decisionOf(o, o.pair.degradation.element) === 'this').length,
    total: of.length,
  });
  return [
    { name: 'all', rate: rate(degraded) },
    ...degradations.map((d) => ({ name: sensitivityName(d), rate: rate(degraded.filter((o) => o.pair.degradation?.name === d.name)) })),
  ];
}

const ANSWER_OF: Readonly<Record<ElementDecision, Answer | null>> = { this: 'A', baseline: 'B', indistinguishable: 'same', uncertain: null };

/** Human agreement per element: the share of the counted labeled pairs whose decision equals the answer of the entry. */
export function humanAgreement(outcomes: readonly PairOutcome[], elements: readonly string[]): { element: string; rate: Rate }[] {
  const labeledPairs = counted(outcomes, 'label');
  return elements.map((element) => {
    const agree = labeledPairs.filter((o) => {
      const decision = decisionOf(o, element);
      const answer = o.pair.label?.answers[element];
      return decision !== undefined && answer !== undefined && ANSWER_OF[decision] === answer;
    });
    return { element, rate: { count: agree.length, total: labeledPairs.length } };
  });
}

export function rates(
  outcomes: readonly PairOutcome[],
  elements: readonly string[],
  degradations: readonly Pick<Degradation, 'name' | 'element'>[],
  labels: number,
  minDecisions: number,
): Rates {
  return {
    falseWin: falseWinRate(outcomes),
    order: agreementValues(orderItems(outcomes, elements), elements),
    retest: agreementValues(retestItems(outcomes, elements), elements),
    sensitivity: sensitivity(outcomes, degradations),
    agreement: humanAgreement(outcomes, elements),
    labels,
    minDecisions,
  };
}

/** A value of order consistency, retest agreement or sensitivity below this asks for a judge panel. */
export const AGREEMENT_RATE_MIN = 0.8;
/** A kappa below this asks for a judge panel. */
export const KAPPA_MIN = 0.6;
/** A value of human agreement below this asks for a judge panel. */
export const HUMAN_AGREEMENT_MIN = 0.6;

/** The recommendation lines of the rates (ogw.md `## judge calibrate`). */
export function recommendations(r: Rates, judgeVotes: number): string[] {
  const min = r.minDecisions;
  const counts = (rate: Rate): boolean => countsRate(rate, min);
  const below = (rate: Rate, threshold: number): boolean => counts(rate) && rate.count / rate.total < threshold;
  const lines: string[] = [];
  if (counts(r.falseWin) && r.falseWin.count > 0) lines.push(`raise loop.judgeVotes to ${String(judgeVotes + 2)} (false win rate ${formatRate(r.falseWin, min)})`);
  const panel: string[] = [];
  for (const [name, values] of [['order consistency', r.order], ['retest agreement', r.retest]] as const) {
    for (const v of values) {
      if (below(v.rate, AGREEMENT_RATE_MIN)) panel.push(`${name} ${v.name} ${formatRate(v.rate, min)}`);
      if (counts(v.rate) && v.kappa !== null && v.kappa < KAPPA_MIN) panel.push(`${name} ${v.name} ${formatKappa(v, min)}`);
    }
  }
  for (const v of r.sensitivity) if (below(v.rate, AGREEMENT_RATE_MIN)) panel.push(`sensitivity ${v.name} ${formatRate(v.rate, min)}`);
  for (const { element, rate } of r.agreement) if (below(rate, HUMAN_AGREEMENT_MIN)) panel.push(`human agreement ${element} ${formatRate(rate, min)}`);
  if (panel.length > 0) {
    lines.push(`set loop.judgePanel to judges that mix Claude Code models and efforts; add Codex judges only when the Codex CLI is logged in (${panel.join(', ')})`);
  }
  return lines;
}

/** The `## rates` lines, without their `- `. */
export function rateLines(r: Rates): string[] {
  const min = r.minDecisions;
  const withKappa = (values: readonly KappaValue[]): string => values.map((v) => `${v.name} ${formatRate(v.rate, min)} ${formatKappa(v, min)}`).join(', ');
  const agreement = r.agreement.every((a) => a.rate.total === 0) ? 'none' : r.agreement.map((a) => `${a.element} ${formatRate(a.rate, min)}`).join(', ');
  return [
    `false win rate: ${formatRate(r.falseWin, min)}`,
    `order consistency: ${withKappa(r.order)}`,
    `retest agreement: ${withKappa(r.retest)}`,
    `sensitivity: ${r.sensitivity.map((v) => `${v.name} ${formatRate(v.rate, min)}`).join(', ')}`,
    `human agreement: ${agreement}`,
    `labels: ${String(r.labels)}`,
  ];
}

function statusText(o: PairOutcome): string {
  return o.status === 'not judged' ? `not judged (${o.pair.missing ?? ''} missing)` : o.status;
}

function bullets(lines: readonly string[]): string {
  return lines.map((l) => `- ${l}`).join('\n');
}

/** An element cell of `## pairs`: the decision and votes of each judging of a counted pair, joined with `; `. */
function elementCell(o: PairOutcome, element: string): string {
  if (o.status !== 'counted' || o.judgings === null) return '';
  return o.judgings
    .map((judging) => judging.find((x) => x.element === element))
    .filter((v): v is ElementVotes => v !== undefined)
    .map((v) => `${v.decision} (${String(v.this)}/${String(v.baseline)})`)
    .join('; ');
}

/** The report `records/calibration/<unix ms>.md`. */
export function renderReport(outcomes: readonly PairOutcome[], elements: readonly string[], r: Rates, judgeVotes: number): string {
  const pairRows = outcomes.map((o) => [o.pair.name, o.pair.commit, o.pair.baseline, statusText(o), ...elements.map((element) => elementCell(o, element))]);
  const judgeRows = outcomes.flatMap((o) =>
    o.judges.map((j) => [o.pair.name, String(j.k), j.entry.instanceSide, j.entry.status, `${j.entry.agent.cli} ${j.entry.agent.model} ${j.entry.agent.effort}`, j.entry.result]),
  );
  return document([
    ['rates', bullets(rateLines(r))],
    ['recommendations', bullets(recommendations(r, judgeVotes))],
    ['pairs', renderTable(['pair', 'this', 'baseline', 'status', ...elements], pairRows)],
    ['judges', judgeRows.length === 0 ? 'none' : renderTable(['pair', 'k', 'this side', 'status', 'agent', 'result'], judgeRows)],
  ]);
}

/** The `## rates` and `## recommendations` lines of a report, without their `- `. */
export function parseReport(text: string): { rates: string[]; recommendations: string[] } {
  const items = (heading: string): string[] =>
    (section(text, heading) ?? []).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim());
  return { rates: items('rates'), recommendations: items('recommendations') };
}
