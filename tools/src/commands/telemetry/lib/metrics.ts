import { OgwError } from '../../../lib/errors.ts';

/** QACore telemetry JSON (qa-core `### telemetry`). Fields are read loosely: a missing list is empty. */
export interface Telemetry {
  started_at: number;
  inputs: { at: number; command: string; latency_ms: number | null; feedback: Record<string, number> }[];
  /** `play_at`: ms played since the telemetry started, without the time step mode did not step (QACore); absent from an older core. */
  rewards: { at: number; play_at?: number; kind: string; id: number; amount: number }[];
  marks: { at: number; play_at?: number; kind: string }[];
  /** `duration_ms`: ms played in the span, without the time step mode did not step (QACore); absent from an older core. */
  idle_spans: { start_at: number; end_at: number | null; duration_ms?: number | null }[];
  goal_intervals: { start_at: number; end_at: number; duration_ms?: number; input_count: number }[];
  scene_loads: { at: number; scene_key: string; duration_ms: number }[];
  dropped: number;
  /** Set only on a window (`windowTelemetry`): the `at` of the instance's first input, null when it has none. */
  first_input_at?: number | null;
  /** Set only on a window (`windowTelemetry`): the scene loads of the whole telemetry, which give the scene at a time. */
  all_scene_loads?: { at: number; scene_key: string; duration_ms: number }[];
}

/**
 * Scene keys whose mode in play-guide `## play mode` is `free`. null when no scene has another mode or there is no
 * play guide: then no scene time is left out (game-design metric table).
 */
export type FreeScenes = ReadonlySet<string> | null;

/** Telemetry and `QAState` of one instance, the raw data of the metrics. */
export interface Sample {
  telemetry: Telemetry;
  state: Record<string, unknown>;
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Reads a `get_telemetry` result. */
export function toTelemetry(value: unknown): Telemetry {
  if (typeof value !== 'object' || value === null) throw new OgwError('telemetry is not a JSON object');
  const t = value as Record<string, unknown>;
  if (typeof t.started_at !== 'number') throw new OgwError('telemetry has no started_at');
  return {
    started_at: t.started_at,
    inputs: list(t.inputs),
    rewards: list(t.rewards),
    marks: list(t.marks),
    idle_spans: list(t.idle_spans),
    goal_intervals: list(t.goal_intervals),
    scene_loads: list(t.scene_loads),
    dropped: typeof t.dropped === 'number' ? t.dropped : 0,
  };
}

/** Median; the smaller of the two middle values when the count is even. null when there is no value. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/** The feedback kinds of `qa-core` `### telemetry`, which cap the kinds counted per input. */
const FEEDBACK_KINDS = 5;

function feedbackKinds(feedback: Record<string, number> | undefined): number {
  return Math.min(FEEDBACK_KINDS, Object.values(feedback ?? {}).filter((n) => typeof n === 'number' && n > 0).length);
}

/** The played time of a reward or mark; null without `play_at`: device time also runs while a step scene waits. */
function playedAt(entry: { play_at?: number }): number | null {
  return typeof entry.play_at === 'number' ? entry.play_at : null;
}

function playedTimes(entries: readonly { play_at?: number }[]): number[] {
  return entries.map(playedAt).filter((at): at is number => at !== null);
}

/** The scene loads in time order; on a window, those of the whole telemetry. */
function sceneLoads(t: Telemetry): Telemetry['scene_loads'] {
  return [...(t.all_scene_loads ?? t.scene_loads)].sort((a, b) => a.at - b.at);
}

/** True when the scene at device time `at` (the last scene load at or before it) is a free scene. */
function inFreeScene(t: Telemetry, free: FreeScenes, at: number): boolean {
  if (free === null) return false;
  const scene = sceneLoads(t).filter((l) => l.at <= at).at(-1)?.scene_key;
  return scene !== undefined && free.has(scene);
}

/** Device ms of [from, to) spent in free scenes; in a free scene step mode is off, so device time is played time. */
function freeMs(t: Telemetry, free: FreeScenes, from: number, to: number): number {
  if (free === null) return 0;
  const loads = sceneLoads(t);
  let total = 0;
  loads.forEach((load, i) => {
    if (!free.has(load.scene_key)) return;
    const start = Math.max(load.at, from);
    const end = Math.min(loads[i + 1]?.at ?? Infinity, to);
    if (end > start) total += end - start;
  });
  return total;
}

/**
 * Per `Fail` mark followed by a `Restart` mark, the device ms from the last input between them to that `Restart`
 * mark: the wait on the result screen before the input is the player's, not the game's.
 */
function restartDelays(t: Telemetry): number[] {
  const delays: number[] = [];
  t.marks.forEach((mark, i) => {
    if (mark.kind !== 'Fail') return;
    const restart = t.marks.slice(i + 1).find((m) => m.kind === 'Restart');
    if (!restart) return;
    const inputs = t.inputs.filter((x) => x.at > mark.at && x.at <= restart.at).map((x) => x.at);
    if (inputs.length > 0) delays.push(restart.at - Math.max(...inputs));
  });
  return delays;
}

/** Per instance, the `play_at` of the first reward without the free scene time before it. */
function firstReward(t: Telemetry, free: FreeScenes): number | null {
  let first: { at: number; play_at: number } | null = null;
  for (const r of t.rewards) {
    const played = playedAt(r);
    if (played !== null && (first === null || played < first.play_at)) first = { at: r.at, play_at: played };
  }
  return first === null ? null : Math.max(0, first.play_at - freeMs(t, free, t.started_at, first.at));
}

/** `duration_ms` of each goal interval without the free scene time in it. */
function goalIntervals(t: Telemetry, free: FreeScenes): number[] {
  return t.goal_intervals
    .filter((g) => typeof g.duration_ms === 'number')
    .map((g) => Math.max(0, (g.duration_ms as number) - freeMs(t, free, g.start_at, g.end_at)));
}

function rewardIntervals(t: Telemetry): number[] {
  const times = playedTimes(t.rewards).sort((a, b) => a - b);
  return times.slice(1).map((at, i) => at - (times[i] as number));
}

/** The `at` of the instance's first input, also for a window that starts after it; null when it has none. */
function firstInputAt(t: Telemetry): number | null {
  if (t.first_input_at !== undefined) return t.first_input_at;
  return t.inputs.length === 0 ? null : Math.min(...t.inputs.map((i) => i.at));
}

/**
 * Lengths of the closed idle spans that start at or after the instance's first input and outside a free scene. A span
 * before it is the wait before anyone played the instance (for example while the judge played the other one), and a
 * span in a free scene is the time the agent took between inputs; neither is the game's.
 * null when such a span has no `duration_ms`.
 */
function playedIdleSpans(t: Telemetry, free: FreeScenes): number[] | null {
  const first = firstInputAt(t);
  if (first === null) return [];
  const spans = t.idle_spans.filter((i) => i.end_at !== null && i.start_at >= first && !inFreeScene(t, free, i.start_at));
  if (spans.some((i) => typeof i.duration_ms !== 'number')) return null;
  return spans.map((i) => i.duration_ms as number);
}

function idleSpanMs(samples: readonly Sample[], free: FreeScenes): number | null {
  const spans = samples.map((x) => playedIdleSpans(x.telemetry, free));
  if (spans.some((s) => s === null)) return null;
  return median(spans.flat() as number[]) ?? 0;
}

function noResponsePermille(samples: readonly Sample[]): number | null {
  const inputs = samples.flatMap((s) => s.telemetry.inputs);
  if (inputs.length === 0) return null;
  return Math.floor((inputs.filter((i) => i.latency_ms === null).length * 1000) / inputs.length);
}

function contentValue(samples: readonly Sample[], field: string): number | null {
  const values = samples
    .map((s) => (s.state.content as Record<string, unknown> | undefined)?.[field])
    .filter((v): v is number => typeof v === 'number' && Number.isInteger(v));
  return median(values);
}

type Calc = (samples: readonly Sample[], free: FreeScenes) => number | null;

const CALCS: Record<string, Calc> = {
  input_latency_ms: (s) =>
    median(s.flatMap((x) => x.telemetry.inputs.map((i) => i.latency_ms)).filter((v): v is number => v !== null)),
  no_response_permille: noResponsePermille,
  feedback_per_input: (s) => median(s.flatMap((x) => x.telemetry.inputs.map((i) => feedbackKinds(i.feedback)))),
  first_reward_ms: (s, free) => median(s.map((x) => firstReward(x.telemetry, free)).filter((v): v is number => v !== null)),
  reward_interval_ms: (s) => median(s.flatMap((x) => rewardIntervals(x.telemetry))),
  goal_interval_ms: (s, free) => median(s.flatMap((x) => goalIntervals(x.telemetry, free))),
  goal_input_count: (s) => median(s.flatMap((x) => x.telemetry.goal_intervals.map((g) => g.input_count))),
  fail_count: (s) => median(s.map((x) => x.telemetry.marks.filter((m) => m.kind === 'Fail').length)),
  restart_delay_ms: (s) => median(s.flatMap((x) => restartDelays(x.telemetry))),
  idle_span_ms: idleSpanMs,
  scene_load_ms: (s) => {
    const loads = s.flatMap((x) => x.telemetry.scene_loads.map((l) => l.duration_ms));
    return loads.length === 0 ? null : Math.max(...loads);
  },
};

export function isMetric(name: string): boolean {
  return name in CALCS || /^content\.[A-Za-z0-9_]+$/.test(name);
}

/**
 * Value of a metric (game-design metric table) over the samples, whose play guide gives `free`; null when it has no
 * value.
 */
export function metricValue(metric: string, samples: readonly Sample[], free: FreeScenes = null): number | null {
  if (metric.startsWith('content.')) return contentValue(samples, metric.slice('content.'.length));
  const calc = CALCS[metric];
  if (!calc) throw new OgwError(`unknown metric: ${metric}`);
  return calc(samples, free);
}

function within(at: number, from: number, to: number): boolean {
  return at >= from && at < to;
}

/**
 * Telemetry items whose time is in [started_at + from, started_at + to). Spans use their start. The window keeps the
 * instance's first input in `first_input_at`, as an input before the window still ends the wait before play, and
 * every scene load in `all_scene_loads`, as a scene loaded before the window is still the scene at its start.
 */
export function windowTelemetry(t: Telemetry, fromMs: number, toMs: number): Telemetry {
  const from = t.started_at + fromMs;
  const to = t.started_at + toMs;
  return {
    ...t,
    first_input_at: firstInputAt(t),
    all_scene_loads: t.all_scene_loads ?? t.scene_loads,
    inputs: t.inputs.filter((i) => within(i.at, from, to)),
    rewards: t.rewards.filter((r) => within(r.at, from, to)),
    marks: t.marks.filter((m) => within(m.at, from, to)),
    idle_spans: t.idle_spans.filter((i) => within(i.start_at, from, to)),
    goal_intervals: t.goal_intervals.filter((g) => within(g.start_at, from, to)),
    scene_loads: t.scene_loads.filter((l) => within(l.at, from, to)),
  };
}
