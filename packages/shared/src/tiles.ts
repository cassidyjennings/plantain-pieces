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
