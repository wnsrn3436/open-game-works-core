import type { HarnessSettings } from '../../../lib/settings.ts';

/** How the baseline instances of a degraded pair start: their `--input-latency`, `--network-delay`, `--feedback-off` and `--reward-presentation-off`. */
export interface BaselineDegrade {
  /** `--input-latency`; 0 for none. */
  latencyMs: number;
  /** `--network-delay`; 0 for none. */
  networkDelayMs: number;
  feedbackOff: boolean;
  rewardPresentationOff: boolean;
}

/** A degradation of the baseline instances of a degraded pair (ogw.md `## judge calibrate`). */
export interface Degradation {
  name: 'latency' | 'network' | 'feedback' | 'reward';
  /** The element the degradation makes worse; an element of a fun iteration. */
  element: string;
  /** How the baseline instances start. */
  baseline(calibration: HarnessSettings['calibration']): BaselineDegrade;
}

/** Baseline instances that start without a degradation. */
const NO_DEGRADE: BaselineDegrade = { latencyMs: 0, networkDelayMs: 0, feedbackOff: false, rewardPresentationOff: false };

/** The degradations, in report order. */
export const DEGRADATIONS: readonly Degradation[] = [
  { name: 'latency', element: 'game feel', baseline: (c) => ({ ...NO_DEGRADE, latencyMs: c.degradeLatencyMs }) },
  { name: 'network', element: 'no friction', baseline: (c) => ({ ...NO_DEGRADE, networkDelayMs: c.degradeNetworkDelayMs }) },
  { name: 'feedback', element: 'game feel', baseline: () => ({ ...NO_DEGRADE, feedbackOff: true }) },
  { name: 'reward', element: 'tension and release', baseline: () => ({ ...NO_DEGRADE, rewardPresentationOff: true }) },
];

/** The name of the sensitivity value of a degradation: `<degradation> (<target element>)`. */
export function sensitivityName(degradation: Pick<Degradation, 'name' | 'element'>): string {
  return `${degradation.name} (${degradation.element})`;
}
