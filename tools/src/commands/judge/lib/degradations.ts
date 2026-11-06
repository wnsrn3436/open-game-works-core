import type { HarnessSettings } from '../../../lib/settings.ts';

/** A degradation of the baseline instances of a degraded pair (ogw.md `## judge calibrate`). */
export interface Degradation {
  name: 'latency' | 'network';
  /** The element the degradation makes worse; an element of a fun iteration. */
  element: string;
  /** The `--input-latency` and `--network-delay` of the baseline instances; 0 for none. */
  baseline(calibration: HarnessSettings['calibration']): { latencyMs: number; networkDelayMs: number };
}

/** The degradations, in report order. */
export const DEGRADATIONS: readonly Degradation[] = [
  { name: 'latency', element: 'game feel', baseline: (c) => ({ latencyMs: c.degradeLatencyMs, networkDelayMs: 0 }) },
  { name: 'network', element: 'no friction', baseline: (c) => ({ latencyMs: 0, networkDelayMs: c.degradeNetworkDelayMs }) },
];

/** The name of the sensitivity value of a degradation: `<degradation> (<target element>)`. */
export function sensitivityName(degradation: Pick<Degradation, 'name' | 'element'>): string {
  return `${degradation.name} (${degradation.element})`;
}
