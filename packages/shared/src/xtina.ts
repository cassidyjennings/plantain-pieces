/**
 * Xtina mode — the scripted board.
 *
 * A hidden two-player mode: the partner account is dealt exactly one word's tiles at a time and
 * builds a fixed 10-word crossword; the owner account is dealt only X and Z and can never form a
 * word. This module is the single source of truth for the whole thing — hint outlines, accent
 * colors, the placement gate, the Bunch composition and the per-step deal are all DERIVED from
 * XTINA_WORDS rather than restated, so the pieces cannot drift apart.
 *
 * The per-step letter arrays have a hand-written twin in SQL (`_xtina_step_letters`), the same
 * keep-in-sync arrangement this repo already uses for TILE_DISTRIBUTION/_fresh_bunch() and
 * scaledBunchDistribution/_scaled_bunch. scripts/smoke-xtina.mjs asserts the two agree.
 */
import { makeKey } from './grid.js';
import type { GridState, Letter, LetterCounts } from './types.js';

export interface XtinaWord {
  word: string;
  /** Cell of the word's first letter. */
  x: number;
  y: number;
  dir: 'H' | 'V';
  /** Rendered in the accent color rather than the ordinary tile color. */
  accent: boolean;
}

/**
 * Deal order. Every entry after the first shares exactly one cell with a word already placed, so
 * the grid is connected and orphan-free at every step — which matters because Peel auto-fires on
 * STRUCTURAL validity (all tiles placed, connected, no orphans), checked long before any
 * dictionary lookup.
 *
 * Ordering is fixed by the design: YOURE first, MY second-to-last, LOVE last.
 */
export const XTINA_WORDS: XtinaWord[] = [
  { word: 'YOURE',       x: 18, y: 22, dir: 'H', accent: true  },
  { word: 'BEAUTIFUL',   x: 20, y: 19, dir: 'V', accent: false }, // shares U @20,22
  { word: 'INTELLIGENT', x: 20, y: 24, dir: 'H', accent: false }, // shares I @20,24
  { word: 'CARING',      x: 29, y: 20, dir: 'V', accent: false }, // shares N @29,24
  { word: 'STRONG',      x: 27, y: 22, dir: 'H', accent: false }, // shares R @29,22
  { word: 'HILARIOUS',   x: 25, y: 22, dir: 'V', accent: false }, // shares L @25,24
  { word: 'SPECIAL',     x: 25, y: 30, dir: 'H', accent: false }, // shares S @25,30
  { word: 'DRIVEN',      x: 29, y: 28, dir: 'V', accent: false }, // shares I @29,30
  { word: 'MY',          x: 18, y: 21, dir: 'V', accent: true  }, // shares Y @18,22
  { word: 'LOVE',        x: 20, y: 27, dir: 'H', accent: true  }, // shares L @20,27
];

export const XTINA_STEPS = XTINA_WORDS.length;

/** Both players are dealt the same count at Split so the public tile-count pills stay symmetric. */
export const XTINA_OWNER_DEAL = 5;

/**
 * The owner's tiles for the entire game, in draw order: the first XTINA_OWNER_DEAL at Split, then
 * one per Peel. Deliberately nothing but X and Z, so no word is ever possible.
 */
export const XTINA_OWNER_TILES: Letter[] = Array.from(
  { length: XTINA_OWNER_DEAL + (XTINA_STEPS - 1) },
  (_, i) => (i % 2 === 0 ? 'X' : 'Z'),
);

/** Cells a word occupies, in reading order. */
export function xtinaWordCells(w: XtinaWord): { key: string; letter: Letter }[] {
  return [...w.word].map((letter, i) => ({
    key: w.dir === 'H' ? makeKey(w.x + i, w.y) : makeKey(w.x, w.y + i),
    letter,
  }));
}

/** The cumulative finished grid after `step` words (1-based). `xtinaTarget(0)` is empty. */
export function xtinaTarget(step: number): GridState {
  const grid: GridState = {};
  for (const w of XTINA_WORDS.slice(0, step)) {
    for (const { key, letter } of xtinaWordCells(w)) grid[key] = letter;
  }
  return grid;
}

/**
 * The cells word `step` adds that are not already occupied — i.e. exactly the dotted outlines to
 * draw. A word's shared hook letter is already on the board and is never hinted.
 */
export function xtinaHintCells(step: number): Set<string> {
  const occupied = new Set(Object.keys(xtinaTarget(step - 1)));
  const keys = xtinaWordCells(XTINA_WORDS[step - 1]).map((c) => c.key);
  return new Set(keys.filter((k) => !occupied.has(k)));
}

/** The letters dealt at `step` — by construction, one per hinted cell. */
export function xtinaStepLetters(step: number): Letter[] {
  const hinted = xtinaHintCells(step);
  return xtinaWordCells(XTINA_WORDS[step - 1])
    .filter((c) => hinted.has(c.key))
    .map((c) => c.letter);
}

/** Cells belonging to an accent word (YOURE, MY, LOVE), including their shared letters. */
export function xtinaAccentCells(): Set<string> {
  const keys = new Set<string>();
  for (const w of XTINA_WORDS) {
    if (!w.accent) continue;
    for (const { key } of xtinaWordCells(w)) keys.add(key);
  }
  return keys;
}

/**
 * Whether the player's grid is exactly the cumulative target for `step`. This is the soft gate:
 * tiles placed anywhere else simply don't advance the script — no error, no rejected drag.
 */
export function xtinaGridMatches(grid: GridState, step: number): boolean {
  const target = xtinaTarget(step);
  const targetKeys = Object.keys(target);
  if (Object.keys(grid).length !== targetKeys.length) return false;
  return targetKeys.every((k) => grid[k] === target[k]);
}

/**
 * The scripted Bunch: every tile either player will ever be dealt, and not one more. Sized so
 * bunch_count reaches exactly 0 as LOVE's letters are dealt, which is what makes the client's
 * auto-action fire Plantains instead of a tenth Peel with no endgame special-casing.
 */
export function xtinaBunch(): LetterCounts {
  const counts: LetterCounts = {};
  const add = (l: Letter) => { counts[l] = (counts[l] ?? 0) + 1; };
  for (let step = 1; step <= XTINA_STEPS; step++) xtinaStepLetters(step).forEach(add);
  XTINA_OWNER_TILES.forEach(add);
  return counts;
}

export const XTINA_BUNCH_SIZE = Object.values(xtinaBunch()).reduce((a, b) => a + b, 0);
