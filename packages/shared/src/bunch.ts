import type { Letter, LetterCounts } from './types.js';
import { countTiles } from './tiles.js';

/**
 * Reference implementation of an unbiased single draw from a counts map.
 * The DB RPC mirrors this exact algorithm under a row lock (the DB is authoritative);
 * this version is used for simulation and tests.
 *
 * @param counts   letter -> remaining count (mutated in place: the drawn letter is decremented)
 * @param rand     a function returning a float in [0, 1); defaults to Math.random
 * @returns the drawn letter, or null if the Bunch is empty
 */
export function drawTile(counts: LetterCounts, rand: () => number = Math.random): Letter | null {
  const total = countTiles(counts);
  if (total === 0) return null;
  // Pick an index in [0, total) and walk the cumulative counts to find its letter.
  let idx = Math.floor(rand() * total);
  for (const letter of Object.keys(counts).sort()) {
    const n = counts[letter];
    if (n <= 0) continue;
    if (idx < n) {
      counts[letter] = n - 1;
      return letter;
    }
    idx -= n;
  }
  // Unreachable when total > 0, but keeps the type checker happy.
  return null;
}

/** Draw up to `n` tiles. Returns fewer than `n` only if the Bunch runs out. */
export function drawTiles(counts: LetterCounts, n: number, rand: () => number = Math.random): Letter[] {
  const drawn: Letter[] = [];
  for (let i = 0; i < n; i++) {
    const t = drawTile(counts, rand);
    if (t === null) break;
    drawn.push(t);
  }
  return drawn;
}

/** Return a tile to the Bunch (used by Dump). */
export function returnTile(counts: LetterCounts, letter: Letter): void {
  counts[letter] = (counts[letter] ?? 0) + 1;
}
