import type { GridState, Letter, StructuralResult } from './types.js';

export function makeKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function parseKey(key: string): { x: number; y: number } {
  const [x, y] = key.split(',').map(Number);
  return { x, y };
}

/** Multiset (letter -> count) of all letters currently on the grid. */
export function gridLetters(grid: GridState): Record<Letter, number> {
  const counts: Record<Letter, number> = {};
  for (const letter of Object.values(grid)) {
    counts[letter] = (counts[letter] ?? 0) + 1;
  }
  return counts;
}

/** Multiset of a flat list of letters (e.g. a player's dealt tiles). */
export function letterMultiset(letters: Letter[]): Record<Letter, number> {
  const counts: Record<Letter, number> = {};
  for (const letter of letters) counts[letter] = (counts[letter] ?? 0) + 1;
  return counts;
}

function multisetsEqual(a: Record<Letter, number>, b: Record<Letter, number>): number {
  // Returns 0 if equal, <0 if `a` has fewer total than `b` (tiles remaining),
  // >0 if `a` has more (extra/unknown tiles).
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let diff = 0;
  for (const k of keys) diff += (a[k] ?? 0) - (b[k] ?? 0);
  return diff;
}

/**
 * Extract every horizontal and vertical run of length >= 2 as an uppercase word.
 * A run is a maximal sequence of horizontally/vertically adjacent occupied cells.
 */
export function extractWords(grid: GridState): string[] {
  const words: string[] = [];
  const cells = Object.keys(grid).map(parseKey);
  if (cells.length === 0) return words;

  const occupied = new Set(Object.keys(grid));
  const has = (x: number, y: number) => occupied.has(makeKey(x, y));

  // Horizontal runs: a run starts where there is no tile to the left.
  for (const { x, y } of cells) {
    if (!has(x - 1, y) && has(x + 1, y)) {
      let word = '';
      let cx = x;
      while (has(cx, y)) {
        word += grid[makeKey(cx, y)];
        cx++;
      }
      words.push(word);
    }
  }
  // Vertical runs: a run starts where there is no tile above.
  for (const { x, y } of cells) {
    if (!has(x, y - 1) && has(x, y + 1)) {
      let word = '';
      let cy = y;
      while (has(x, cy)) {
        word += grid[makeKey(x, cy)];
        cy++;
      }
      words.push(word);
    }
  }
  return words;
}

/** Cells that are not part of any horizontal or vertical run of length >= 2. */
export function findOrphans(grid: GridState): string[] {
  const occupied = new Set(Object.keys(grid));
  const has = (x: number, y: number) => occupied.has(makeKey(x, y));
  const orphans: string[] = [];
  for (const key of occupied) {
    const { x, y } = parseKey(key);
    const inHorizontal = has(x - 1, y) || has(x + 1, y);
    const inVertical = has(x, y - 1) || has(x, y + 1);
    if (!inHorizontal && !inVertical) orphans.push(key);
  }
  return orphans;
}

/** Whether all occupied cells form a single 4-connected component. */
export function isConnected(grid: GridState): boolean {
  const keys = Object.keys(grid);
  if (keys.length <= 1) return true;
  const occupied = new Set(keys);
  const seen = new Set<string>();
  const stack = [keys[0]];
  seen.add(keys[0]);
  while (stack.length) {
    const { x, y } = parseKey(stack.pop()!);
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ]) {
      const nk = makeKey(nx, ny);
      if (occupied.has(nk) && !seen.has(nk)) {
        seen.add(nk);
        stack.push(nk);
      }
    }
  }
  return seen.size === occupied.size;
}

/**
 * Structural validation of a completed grid against the exact tiles the player holds.
 * Enforces: non-empty, uses every dealt tile (and no extras), fully connected, no orphans.
 * Dictionary validity is layered on separately (see validateWithDictionary).
 *
 * @param grid        the player's grid
 * @param dealtTiles  every tile ever dealt to the player (their full inventory)
 */
export function validateStructure(grid: GridState, dealtTiles: Letter[]): StructuralResult {
  const words = extractWords(grid);
  const orphans = findOrphans(grid);

  if (Object.keys(grid).length === 0) {
    return { valid: false, reason: 'EMPTY_GRID', words, orphans };
  }

  const diff = multisetsEqual(gridLetters(grid), letterMultiset(dealtTiles));
  if (diff < 0) return { valid: false, reason: 'TILES_REMAINING', words, orphans };
  if (diff > 0) return { valid: false, reason: 'EXTRA_TILES', words, orphans };

  if (!isConnected(grid)) return { valid: false, reason: 'NOT_CONNECTED', words, orphans };
  if (orphans.length > 0) return { valid: false, reason: 'ORPHAN_TILE', words, orphans };

  return { valid: true, words, orphans };
}

/**
 * Full validation = structural validation + dictionary check.
 * `isValidWord` is supplied by the caller (client: local dictionary; server: DB lookup set).
 */
export function validateWithDictionary(
  grid: GridState,
  dealtTiles: Letter[],
  isValidWord: (word: string) => boolean,
): StructuralResult {
  const structural = validateStructure(grid, dealtTiles);
  if (!structural.valid) return structural;

  const invalidWords = structural.words.filter((w) => !isValidWord(w));
  if (invalidWords.length > 0) {
    return { ...structural, valid: false, reason: 'INVALID_WORDS', invalidWords };
  }
  return structural;
}
