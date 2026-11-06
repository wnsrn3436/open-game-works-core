/**
 * Chance-corrected agreement of judge calibration (ogw.md `## judge calibrate` kappa): (p_o − p_e) ÷ (1 − p_e) over
 * items that each have one rating per rater. A result of null is `undefined`: p_e is 1 (every rating is in one
 * category) or there is no item.
 */

function ratio(observed: number, expected: number): number | null {
  if (expected >= 1) return null;
  return (observed - expected) / (1 - expected);
}

/** Cohen's kappa of two raters: each item is the rating of the first rater and that of the second. */
export function cohenKappa(items: readonly (readonly [string, string])[]): number | null {
  if (items.length === 0) return null;
  const n = items.length;
  const first = new Map<string, number>();
  const second = new Map<string, number>();
  let same = 0;
  for (const [a, b] of items) {
    if (a === b) same += 1;
    first.set(a, (first.get(a) ?? 0) + 1);
    second.set(b, (second.get(b) ?? 0) + 1);
  }
  let expected = 0;
  for (const [category, count] of first) expected += (count / n) * ((second.get(category) ?? 0) / n);
  return ratio(same / n, expected);
}

/** Fleiss' kappa: every item has the same number m (at least 2) of ratings. */
export function fleissKappa(items: readonly (readonly string[])[]): number | null {
  const m = items[0]?.length ?? 0;
  if (items.length === 0 || m < 2 || items.some((ratings) => ratings.length !== m)) return null;
  const totals = new Map<string, number>();
  let observed = 0;
  for (const ratings of items) {
    const counts = new Map<string, number>();
    for (const rating of ratings) {
      counts.set(rating, (counts.get(rating) ?? 0) + 1);
      totals.set(rating, (totals.get(rating) ?? 0) + 1);
    }
    let agreeing = 0;
    for (const count of counts.values()) agreeing += count * (count - 1);
    observed += agreeing / (m * (m - 1));
  }
  const all = items.length * m;
  let expected = 0;
  for (const count of totals.values()) expected += (count / all) ** 2;
  return ratio(observed / items.length, expected);
}

/** Cohen's kappa for items of two ratings, Fleiss' kappa for items of more. */
export function kappa(items: readonly (readonly string[])[]): number | null {
  if ((items[0]?.length ?? 0) === 2) return cohenKappa(items.map((ratings) => [ratings[0] as string, ratings[1] as string] as const));
  return fleissKappa(items);
}
