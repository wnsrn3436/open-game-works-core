import { OgwError } from '../../../lib/errors.ts';
import type { Pcm } from './audio.ts';

/**
 * Loudness (ITU-R BS.1770-4 and EBU Tech 3341) and true peak of 48 kHz PCM, and the true peak limiter of
 * `ogw resource finalize` (`production.md` `## finalize` step 2).
 */

/** The rate of the K-weighting coefficients of BS.1770-4; every sound is resampled to it first. */
const RATE = 48000;
/** Gating block and momentary window: 400 ms. */
const BLOCK = (RATE * 400) / 1000;
/** Hop of the gating blocks: 75 % overlap. */
const HOP = BLOCK / 4;
const ABSOLUTE_GATE = -70;
const RELATIVE_GATE = -10;

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** The two stages of the K-weighting filter of BS.1770-4 at 48 kHz: the head shelf, then the RLB high pass. */
const K_WEIGHTING: readonly Biquad[] = [
  { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 },
  { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 },
];

/** BS.1770-4 channel weights: 1 for each channel, and for 6 channels (L R C LFE Ls Rs) no LFE and 1.41 for the surrounds. */
function channelWeights(channels: number): number[] {
  if (channels === 6) return [1, 1, 1, 0, 1.41, 1.41];
  return new Array<number>(channels).fill(1);
}

function requireRate(pcm: Pcm): void {
  if (pcm.sampleRate !== RATE) throw new OgwError(`loudness is measured at ${String(RATE)} Hz, not ${String(pcm.sampleRate)} Hz`);
}

/**
 * The weighted sum over channels of the squared K-weighted samples per frame, with `tail` frames of silence after the
 * sound so that the ring of the filter is counted.
 */
function weightedPower(pcm: Pcm, tail: number): Float64Array {
  const { channels, samples } = pcm;
  const count = samples.length / channels;
  const power = new Float64Array(count + tail);
  const weights = channelWeights(channels);
  for (let c = 0; c < channels; c++) {
    const weight = weights[c] as number;
    if (weight === 0) continue;
    const state = K_WEIGHTING.map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 }));
    for (let f = 0; f < count + tail; f++) {
      let value = f < count ? (samples[f * channels + c] as number) : 0;
      for (const [i, q] of K_WEIGHTING.entries()) {
        const s = state[i] as { x1: number; x2: number; y1: number; y2: number };
        const out = q.b0 * value + q.b1 * s.x1 + q.b2 * s.x2 - q.a1 * s.y1 - q.a2 * s.y2;
        s.x2 = s.x1;
        s.x1 = value;
        s.y2 = s.y1;
        s.y1 = out;
        value = out;
      }
      power[f] = (power[f] as number) + weight * value * value;
    }
  }
  return power;
}

function lufs(meanPower: number): number {
  return -0.691 + 10 * Math.log10(meanPower);
}

/** Running sums: `sums[i]` is the sum of the first `i` values. */
function prefixSums(values: Float64Array): Float64Array {
  const sums = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) sums[i + 1] = (sums[i] as number) + (values[i] as number);
  return sums;
}

/** Mean power of the windows of `length` frames that start every `hop` frames and lie inside the sound. */
function windowPowers(power: Float64Array, length: number, hop: number): number[] {
  const sums = prefixSums(power);
  const powers: number[] = [];
  for (let start = 0; start + length <= power.length; start += hop) powers.push(((sums[start + length] as number) - (sums[start] as number)) / length);
  return powers;
}

/** BS.1770-4 integrated loudness (LUFS); null for a sound shorter than one gating block or with no block over -70 LUFS. */
export function integratedLoudness(pcm: Pcm): number | null {
  requireRate(pcm);
  const blocks = windowPowers(weightedPower(pcm, 0), BLOCK, HOP).filter((p) => p > 0 && lufs(p) > ABSOLUTE_GATE);
  if (blocks.length === 0) return null;
  const relative = lufs(mean(blocks)) + RELATIVE_GATE;
  const gated = blocks.filter((p) => lufs(p) > relative);
  return lufs(mean(gated));
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Maximum momentary loudness (LUFS, EBU Tech 3341): the loudest 400 ms window at any frame, with silence before and
 * after the sound, so that a sound shorter than the window counts all of its energy over 400 ms. Null for silence.
 */
export function maxMomentaryLoudness(pcm: Pcm): number | null {
  requireRate(pcm);
  const power = weightedPower(pcm, BLOCK);
  const sums = prefixSums(power);
  let best = 0;
  for (let end = 1; end <= power.length; end++) best = Math.max(best, (sums[end] as number) - (sums[Math.max(0, end - BLOCK)] as number));
  return best > 0 ? lufs(best / BLOCK) : null;
}

/** Oversampling of the true peak meter: 4 times at 48 kHz (BS.1770-4 Annex 2). */
const OVERSAMPLE = 4;
/** Taps of each phase of the interpolation filter, half before and half after the point. */
const TAPS = 32;
/** Kaiser window shape of the interpolation filter. */
const KAISER_BETA = 6;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/**
 * Phases 1 to 3 of the 4 times interpolation filter (phase 0 is the sample itself): a Kaiser windowed sinc cut at half
 * the sample rate, each phase scaled to a DC gain of 1. `PHASES[p - 1][j]` weighs the sample `j - TAPS / 2 + 1` frames
 * from the frame before the point `p / 4` after it.
 */
const PHASES: readonly Float64Array[] = [1, 2, 3].map((p) => {
  const taps = new Float64Array(TAPS);
  for (let j = 0; j < TAPS; j++) {
    const t = j - TAPS / 2 + 1 - p / OVERSAMPLE;
    const w = besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - (t / (TAPS / 2)) ** 2))) / besselI0(KAISER_BETA);
    taps[j] = (Math.sin(Math.PI * t) / (Math.PI * t)) * w;
  }
  const sum = taps.reduce((a, b) => a + b, 0);
  return taps.map((v) => v / sum);
});
/** The largest gain of a phase to a signal of absolute value at most 1: the bound of an interpolated point. */
const PHASE_BOUND = Math.max(...PHASES.map((taps) => taps.reduce((a, b) => a + Math.abs(b), 0)));

/** The largest absolute value of the samples of each frame across channels. */
function framePeaks(pcm: Pcm): Float64Array {
  const { channels, samples } = pcm;
  const peaks = new Float64Array(samples.length / channels);
  for (let i = 0; i < samples.length; i++) {
    const f = Math.floor(i / channels);
    peaks[f] = Math.max(peaks[f] as number, Math.abs(samples[i] as number));
  }
  return peaks;
}

/** Largest of `values` in each window of `before` frames before and `after` frames after a frame. */
function slidingMax(values: Float64Array, before: number, after: number): Float64Array {
  const out = new Float64Array(values.length);
  const deque: number[] = [];
  let head = 0;
  let next = 0;
  for (let f = 0; f < values.length; f++) {
    for (; next < values.length && next <= f + after; next++) {
      while (deque.length > head && (values[deque[deque.length - 1] as number] as number) <= (values[next] as number)) deque.pop();
      deque.push(next);
    }
    while ((deque[head] as number) < f - before) head++;
    out[f] = values[deque[head] as number] as number;
  }
  return out;
}

/** Interpolated value of channel `c` at `p / 4` frames after frame `f`; silence outside the sound. */
function interpolated(pcm: Pcm, c: number, f: number, p: number): number {
  const { channels, samples } = pcm;
  const count = samples.length / channels;
  const taps = PHASES[p - 1] as Float64Array;
  let value = 0;
  for (let j = 0; j < TAPS; j++) {
    const at = f + j - TAPS / 2 + 1;
    if (at >= 0 && at < count) value += (taps[j] as number) * (samples[at * channels + c] as number);
  }
  return value;
}

/**
 * Per frame, the largest absolute value across channels of the sample and of the 4 times interpolated points within
 * 3/4 frame of it. Points that cannot reach `floor` (their bound from the samples around them is under it) are not
 * computed, and a frame with no such point holds its sample peak.
 */
export function truePeakEnvelope(pcm: Pcm, floor = 0): Float64Array {
  requireRate(pcm);
  const peaks = framePeaks(pcm);
  const near = slidingMax(peaks, TAPS / 2, TAPS / 2);
  const envelope = Float64Array.from(peaks);
  for (let f = 0; f < peaks.length; f++) {
    if ((near[f] as number) * PHASE_BOUND < floor) continue;
    for (let p = 1; p < OVERSAMPLE; p++) {
      let value = 0;
      for (let c = 0; c < pcm.channels; c++) value = Math.max(value, Math.abs(interpolated(pcm, c, f, p)));
      envelope[f] = Math.max(envelope[f] as number, value);
      if (f + 1 < peaks.length) envelope[f + 1] = Math.max(envelope[f + 1] as number, value);
    }
  }
  return envelope;
}

function db(linear: number): number {
  return 20 * Math.log10(linear);
}

/** True peak (dBTP) by 4 times oversampling; null for silence. */
export function truePeak(pcm: Pcm): number | null {
  const samplePeak = framePeaks(pcm).reduce((a, b) => Math.max(a, b), 0);
  if (samplePeak === 0) return null;
  return db(truePeakEnvelope(pcm, samplePeak).reduce((a, b) => Math.max(a, b), 0));
}

/** The limiter reaches the gain a peak needs over this long before the peak (look-ahead). */
const LOOKAHEAD_MS = 5;
/** Time constant of the limiter gain coming back after a peak. */
const RELEASE_MS = 50;
/** For a loop, the frames of its end put before its start, so that the release has settled where the loop starts. */
const LOOP_LEAD_RELEASES = 10;

/** Smallest of `values` in each window of `length` values that starts at an index. */
function forwardMin(values: Float32Array, length: number): Float32Array {
  const out = new Float32Array(values.length);
  const deque: number[] = [];
  let head = 0;
  let next = 0;
  for (let i = 0; i < values.length; i++) {
    for (; next < values.length && next < i + length; next++) {
      while (deque.length > head && (values[deque[deque.length - 1] as number] as number) >= (values[next] as number)) deque.pop();
      deque.push(next);
    }
    while ((deque[head] as number) < i) head++;
    out[i] = values[deque[head] as number] as number;
  }
  return out;
}

/** Mean of `values` in each window of `length` values that ends at an index; before the first value, the window is shorter. */
function backwardMean(values: Float32Array, length: number): Float32Array {
  const out = new Float32Array(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] as number;
    if (i >= length) sum -= values[i - length] as number;
    out[i] = sum / Math.min(length, i + 1);
  }
  return out;
}

/**
 * The gain each frame needs so that its true peak is at most `ceiling`, with `lead` frames put before and `tail` after:
 * of the loop end and start for a loop, of 1 (silence) for a sound played once.
 */
function neededGain(envelope: Float64Array, ceiling: number, lead: number, tail: number, circular: boolean): Float32Array {
  const count = envelope.length;
  const need = new Float32Array(lead + count + tail).fill(1);
  for (let i = 0; i < need.length; i++) {
    const f = i - lead;
    const at = circular ? ((f % count) + count) % count : f;
    if (at < 0 || at >= count) continue;
    const peak = envelope[at] as number;
    if (peak > ceiling) need[i] = ceiling / peak;
  }
  return need;
}

/**
 * True peak limiter (`production.md` `## finalize` step 2): each frame gets the gain that keeps the 4 times oversampled
 * peaks at most `ceilingDbtp`, reached over the `LOOKAHEAD_MS` before a peak (the smallest needed gain of the look-ahead
 * window, averaged over the window before the frame) and coming back with the `RELEASE_MS` time constant. A `circular`
 * sound is limited as it repeats: its end comes before its start and its start after its end.
 */
export function limitTruePeak(pcm: Pcm, ceilingDbtp: number, circular: boolean): Pcm {
  requireRate(pcm);
  const ceiling = 10 ** (ceilingDbtp / 20);
  const envelope = truePeakEnvelope(pcm, ceiling);
  if (!envelope.some((v) => v > ceiling)) return pcm;
  const count = envelope.length;
  const look = Math.max(1, Math.round((LOOKAHEAD_MS * RATE) / 1000));
  const lead = circular ? look + Math.round((LOOP_LEAD_RELEASES * RELEASE_MS * RATE) / 1000) : look;
  const smooth = backwardMean(forwardMin(neededGain(envelope, ceiling, lead, look, circular), look), look);
  const release = 1 - Math.exp(-1000 / (RELEASE_MS * RATE));
  const { channels } = pcm;
  const samples = new Float32Array(pcm.samples.length);
  let gain = smooth[0] as number;
  for (let i = 0; i < lead + count; i++) {
    const want = smooth[i] as number;
    gain = want <= gain ? want : gain + (want - gain) * release;
    const f = i - lead;
    if (f < 0) continue;
    for (let c = 0; c < channels; c++) samples[f * channels + c] = (pcm.samples[f * channels + c] as number) * gain;
  }
  return { ...pcm, samples };
}

/** Mean of each channel (linear). */
export function dcOffsets(pcm: Pcm): number[] {
  const { channels, samples } = pcm;
  const sums = new Array<number>(channels).fill(0);
  for (let i = 0; i < samples.length; i++) sums[i % channels] = (sums[i % channels] as number) + (samples[i] as number);
  const count = samples.length / channels;
  return sums.map((s) => (count === 0 ? 0 : s / count));
}
