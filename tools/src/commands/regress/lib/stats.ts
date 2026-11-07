/** The permutation test of a comparison of the regression suite (ogw.md `### regress comparison` of `## regress`). */

/** mulberry32: a 32-bit PRNG giving floats in [0, 1), the same sequence for the same seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The transformed values of one seed per side. */
export interface SeedValues {
  before: number[];
  after: number[];
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** D: the mean over the seeds of the mean of the after side minus that of the before side. */
export function difference(seeds: readonly SeedValues[]): number {
  return mean(seeds.map((s) => mean(s.after) - mean(s.before)));
}

/** Fisher-Yates shuffle of a copy of `values` with `random`. */
function shuffled(values: readonly number[], random: () => number): number[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as number, out[i] as number];
  }
  return out;
}

export interface TestResult {
  d: number;
  p: number;
}

/**
 * The stratified permutation test: the side labels shuffled within each seed, the count per side kept. p is
 * (1 + the permutations whose |D| is at least the |D| of the values) ÷ (1 + permutations). A tolerance of 1e-12 keeps a
 * permutation equal to the values from counting as smaller through rounding.
 */
export function permutationTest(seeds: readonly SeedValues[], permutations: number, seed: number): TestResult {
  const d = difference(seeds);
  const random = mulberry32(seed);
  let extreme = 0;
  for (let k = 0; k < permutations; k++) {
    const permuted = seeds.map((s) => {
      const pooled = shuffled([...s.before, ...s.after], random);
      return { before: pooled.slice(0, s.before.length), after: pooled.slice(s.before.length) };
    });
    if (Math.abs(difference(permuted)) >= Math.abs(d) - 1e-12) extreme++;
  }
  return { d, p: (1 + extreme) / (1 + permutations) };
}

export type Verdict = 'better' | 'worse' | 'no difference' | 'unknown';

/** The verdict of a measure: by p against `level`, and the way D goes against the way the measure is better. */
export function verdictOf(result: TestResult | null, better: 'higher' | 'lower', level: number): Verdict {
  if (result === null) return 'unknown';
  if (result.p >= level || result.d === 0) return 'no difference';
  return (result.d > 0) === (better === 'higher') ? 'better' : 'worse';
}
