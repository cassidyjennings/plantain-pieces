import type { LetterCounts } from './types.js';

/**
 * Standard Bananagrams 144-tile distribution.
 * Source: official Bananagrams tile counts.
 */
export const TILE_DISTRIBUTION: LetterCounts = {
  A: 13, B: 3, C: 3, D: 6, E: 18, F: 3, G: 4, H: 3, I: 12, J: 2, K: 2, L: 5,
  M: 3, N: 8, O: 11, P: 3, Q: 2, R: 9, S: 6, T: 9, U: 6, V: 3, W: 3, X: 2,
  Y: 3, Z: 2,
};

/** Total tiles in a fresh Bunch (144). */
export const TOTAL_TILES = Object.values(TILE_DISTRIBUTION).reduce((a, b) => a + b, 0);

export const GRID_SIZE = 50;
export const MAX_PLAYERS = 8;

/**
 * Number of tiles dealt to each player at Split, by player count.
 * Matches physical Bananagrams: 2–4 → 21, 5–6 → 15, 7–8 → 11.
 */
export function initialDealCount(playerCount: number): number {
  if (playerCount <= 0) throw new Error('playerCount must be positive');
  if (playerCount <= 4) return 21;
  if (playerCount <= 6) return 15;
  return 11;
}

/** A fresh copy of the full Bunch counts. */
export function freshBunch(): LetterCounts {
  return { ...TILE_DISTRIBUTION };
}

/** Sum of remaining tiles across a counts map. */
export function countTiles(counts: LetterCounts): number {
  let total = 0;
  for (const n of Object.values(counts)) total += n;
  return total;
}

/**
 * A proportionally scaled Bunch for a chosen total tile count (solo mode's configurable Bunch
 * size). Uses the largest-remainder method: each letter's exact share (TILE_DISTRIBUTION[letter]
 * * bunchSize/144) is floored, then the leftover units (always < 26, since 26 fractional shares
 * each under 1 sum to under 26) go one-by-one to the letters with the largest fractional
 * remainder. At bunchSize === TOTAL_TILES this reproduces TILE_DISTRIBUTION exactly (every ratio
 * is an integer, so there's nothing left to round).
 *
 * A second pass then guarantees every letter has >= 1 tile once the bunch is large enough to fit
 * the whole alphabet (bunchSize >= 26) — otherwise a small bunch could plausibly roll zero of a
 * rare letter (Q/X/Z/J/K) and make some real words permanently unplayable. It does this by
 * "borrowing" 1 tile at a time from whichever letter currently has the most, which preserves the
 * exact total and never fires at bunchSize === TOTAL_TILES (every letter there already has >= 2).
 *
 * Uses pure integer arithmetic throughout (a common-denominator remainder numerator, not a
 * floating-point fraction) so it produces byte-identical results to the SQL RPC `_scaled_bunch`
 * (supabase/migrations) for every input — a first version of both used `bunchSize/144` as a
 * float/numeric ratio, which broke exact-tie ordering between the two runtimes: PostgreSQL's
 * `numeric` division and JS's IEEE-754 doubles round a non-terminating fraction like 96/144 = 2/3
 * to *different* decimal tails, so "tied" remainders (e.g. J/K/L/N/O/Q/X/Z all at exactly 1/3)
 * sorted in a different order in SQL than in JS. Integer numerators over the common denominator
 * 144 have no such ambiguity in either runtime. Keep both in sync if this ever changes, same
 * discipline as _initial_deal/initialDealCount.
 */
export function scaledBunchDistribution(bunchSize: number): LetterCounts {
  if (!Number.isInteger(bunchSize) || bunchSize < 0) {
    throw new Error('bunchSize must be a non-negative integer');
  }
  const letters = Object.keys(TILE_DISTRIBUTION).sort();

  const counts: LetterCounts = {};
  const remainders: { letter: string; remainderNumerator: number }[] = [];
  let floorSum = 0;
  for (const letter of letters) {
    const product = TILE_DISTRIBUTION[letter] * bunchSize;
    const floor = Math.floor(product / TOTAL_TILES);
    counts[letter] = floor;
    floorSum += floor;
    remainders.push({ letter, remainderNumerator: product - floor * TOTAL_TILES });
  }

  const remaining = bunchSize - floorSum;
  remainders.sort(
    (a, b) => b.remainderNumerator - a.remainderNumerator || a.letter.localeCompare(b.letter),
  );
  for (let i = 0; i < remaining; i++) {
    counts[remainders[i].letter] += 1;
  }

  if (bunchSize >= letters.length) {
    for (const letter of letters) {
      if (counts[letter] > 0) continue;
      let richest = letters[0];
      for (const l of letters) if (counts[l] > counts[richest]) richest = l;
      counts[richest] -= 1;
      counts[letter] = 1;
    }
  }

  return counts;
}
