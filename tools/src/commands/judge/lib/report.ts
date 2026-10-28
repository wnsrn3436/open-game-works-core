import type { ElementDecision, ElementVotes, JudgeEntry } from '../../loop/lib/files.ts';
import { document, renderTable, section } from '../../loop/lib/markdown.ts';
import type { Answer, LabelEntry } from './pairs.ts';

/** The four kinds of pairs of judge calibration (`game-loop` `## judge calibration`). */
export type PairKind = 'null' | 'order' | 'degraded' | 'label';

/** A pair to judge: its `this` and `baseline` commits, its judges and how their sides go. */
export interface CalibrationPair {
  /** `null-<n>`, `order`, `degraded`, `label-<n>`. */
  name: string;
  kind: PairKind;
  commit: string;
  baseline: string;
  /** `--input-latency` of the baseline instances; 0 for none. */
  baselineLatencyMs: number;
  /** The number of judges of the pair. */
  judges: number;
  /** The side of `this` of the first judge; the sides alternate. */
  first: 'A' | 'B';
  label: LabelEntry | null;
  /** The commit of the pair that is not in the game repo; null when both are. */
  missing: string | null;
}

/** A judge of a pair as it ended. */
export interface PairJudge {
  k: number;
  entry: JudgeEntry;
}

export type PairStatus = 'counted' | 'not counted' | 'not judged';

/** A pair with its judges, its status and, for a counted pair, its votes and element decisions. */
export interface PairOutcome {
  pair: CalibrationPair;
  judges: PairJudge[];
  status: PairStatus;
  votes: ElementVotes[] | null;
}

/** A share: `count` of `total`. */
export interface Rate {
  count: number;
  total: number;
}

export interface Rates {
  falseWin: Rate;
  order: Rate;
  /** null when the degraded pair does not count. */
  sensitivity: boolean | null;
  /** Per element of `elements`. */
  agreement: { element: string; rate: Rate }[];
  labels: number;
}

/** `<value rounded to two decimals> (<count> of <total>)`, `none` when the total is 0. */
export function formatRate(rate: Rate): string {
  if (rate.total === 0) return 'none';
  return `${(rate.count / rate.total).toFixed(2)} (${String(rate.count)} of ${String(rate.total)})`;
}

function counted(outcomes: readonly PairOutcome[], kind: PairKind): PairOutcome[] {
  return outcomes.filter((o) => o.pair.kind === kind && o.status === 'counted' && o.votes !== null);
}

/** False win rate: the share of the element decisions of the counted null pairs that are `this` or `baseline`. */
export function falseWinRate(outcomes: readonly PairOutcome[]): Rate {
  const decisions = counted(outcomes, 'null').flatMap((o) => (o.votes ?? []).map((v) => v.decision));
  return { count: decisions.filter((d) => d === 'this' || d === 'baseline').length, total: decisions.length };
}

/** The side vote of a side assignment: the vote every judge of it gave the element, or `mixed`. */
function sideVote(judges: readonly PairJudge[], side: 'A' | 'B', element: string): string {
  const votes = new Set(judges.filter((j) => j.entry.instanceSide === side).map((j) => j.entry.votes?.[element] ?? null));
  if (votes.size !== 1) return 'mixed';
  return [...votes][0] ?? 'no vote';
}

/** Order consistency: the share of the elements whose side vote is the same for both side assignments and not `mixed`. */
export function orderConsistency(outcomes: readonly PairOutcome[], elements: readonly string[]): Rate {
  const order = counted(outcomes, 'order')[0];
  if (order === undefined) return { count: 0, total: 0 };
  const same = elements.filter((element) => {
    const a = sideVote(order.judges, 'A', element);
    return a !== 'mixed' && a === sideVote(order.judges, 'B', element);
  });
  return { count: same.length, total: elements.length };
}

/** Sensitivity: whether `game feel` of the counted degraded pair is decided `this`; null when it does not count. */
export function sensitivity(outcomes: readonly PairOutcome[]): boolean | null {
  const degraded = counted(outcomes, 'degraded')[0];
  if (degraded === undefined) return null;
  return degraded.votes?.find((v) => v.element === 'game feel')?.decision === 'this';
}

const ANSWER_OF: Readonly<Record<ElementDecision, Answer | null>> = { this: 'A', baseline: 'B', indistinguishable: 'same', uncertain: null };

/** Human agreement per element: the share of the counted labeled pairs whose decision equals the answer of the entry. */
export function humanAgreement(outcomes: readonly PairOutcome[], elements: readonly string[]): { element: string; rate: Rate }[] {
  const labeledPairs = counted(outcomes, 'label');
  return elements.map((element) => {
    const agree = labeledPairs.filter((o) => {
      const decision = o.votes?.find((v) => v.element === element)?.decision;
      const answer = o.pair.label?.answers[element];
      return decision !== undefined && answer !== undefined && ANSWER_OF[decision] === answer;
    });
    return { element, rate: { count: agree.length, total: labeledPairs.length } };
  });
}

export function rates(outcomes: readonly PairOutcome[], elements: readonly string[], labels: number): Rates {
  return {
    falseWin: falseWinRate(outcomes),
    order: orderConsistency(outcomes, elements),
    sensitivity: sensitivity(outcomes),
    agreement: humanAgreement(outcomes, elements),
    labels,
  };
}

/** Order consistency below this asks for a judge panel. */
export const ORDER_MIN = 0.8;
/** A human agreement below this, over at least `AGREEMENT_MIN_TOTAL` labeled pairs, asks for a judge panel. */
export const AGREEMENT_MIN = 0.6;
export const AGREEMENT_MIN_TOTAL = 3;

function below(rate: Rate, min: number): boolean {
  return rate.total > 0 && rate.count / rate.total < min;
}

/** The recommendation lines of the rates (`game-loop` `## judge calibration`). */
export function recommendations(r: Rates, judgeVotes: number): string[] {
  const lines: string[] = [];
  if (r.falseWin.count > 0) lines.push(`raise loop.judgeVotes to ${String(judgeVotes + 2)} (false win rate ${formatRate(r.falseWin)})`);
  const panel: string[] = [];
  if (below(r.order, ORDER_MIN)) panel.push(`order consistency ${formatRate(r.order)}`);
  if (r.sensitivity === false) panel.push('sensitivity no');
  for (const { element, rate } of r.agreement) {
    if (rate.total >= AGREEMENT_MIN_TOTAL && below(rate, AGREEMENT_MIN)) panel.push(`human agreement ${element} ${formatRate(rate)}`);
  }
  if (panel.length > 0) {
    lines.push(`set loop.judgePanel to judges that mix Claude Code models and efforts; add Codex judges only when the Codex CLI is logged in (${panel.join(', ')})`);
  }
  return lines;
}

function sensitivityText(value: boolean | null): string {
  if (value === null) return 'none';
  return value ? 'yes' : 'no';
}

/** The `## rates` lines, without their `- `. */
export function rateLines(r: Rates): string[] {
  const agreement = r.agreement.every((a) => a.rate.total === 0) ? 'none' : r.agreement.map((a) => `${a.element} ${formatRate(a.rate)}`).join(', ');
  return [
    `false win rate: ${formatRate(r.falseWin)}`,
    `order consistency: ${formatRate(r.order)}`,
    `sensitivity: ${sensitivityText(r.sensitivity)}`,
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

/** The report `records/calibration/<unix ms>.md`. */
export function renderReport(outcomes: readonly PairOutcome[], elements: readonly string[], r: Rates, judgeVotes: number): string {
  const pairRows = outcomes.map((o) => [
    o.pair.name,
    o.pair.commit,
    o.pair.baseline,
    statusText(o),
    ...elements.map((element) => {
      const v = o.status === 'counted' ? o.votes?.find((x) => x.element === element) : undefined;
      return v === undefined ? '' : `${v.decision} (${String(v.this)}/${String(v.baseline)})`;
    }),
  ]);
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
