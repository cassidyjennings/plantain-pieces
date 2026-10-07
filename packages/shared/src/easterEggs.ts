/** Easter-egg words — the single source of truth for the client and the Worker.
 *
 * Every word here is ALWAYS valid, in every dictionary and every mode, regardless of the room's
 * dictionary config or length bounds. The SQL twin is `public._easter_egg_words()` (migration
 * 20261006000401) — keep the two lists identical, same order, exactly like the tile distribution
 * is kept in sync between tiles.ts and `_fresh_bunch()`. scripts/smoke-easter-eggs.mjs asserts it.
 *
 * Shipping this list in the public bundle is deliberate: these spread by word of mouth. */
import type { GridState, Letter } from './types.js';
import { extractWords, findOrphans, gridLetters, isConnected, letterMultiset } from './grid.js';

export const EASTER_EGG_WORDS = ['MIT', 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS', 'GHOST', 'FREEZE'] as const;

export type EggWord = (typeof EASTER_EGG_WORDS)[number];

export const SUPERCALI = 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS' as const;

/** How long FREEZE stops the Timed solo clock. `_archive_game_impl` subtracts the same 10000. */
export const FREEZE_DURATION_MS = 10_000 as const;

export type EggEffect = 'tint' | 'instant_win' | 'ghost' | 'freeze';

export interface EasterEggDef {
  effect: EggEffect;
  description: string;
}

export const EASTER_EGGS: Record<EggWord, EasterEggDef> = {
  MIT: { effect: 'tint', description: 'Its tiles turn maroon instead of green.' },
  SUPERCALIFRAGILISTICEXPIALIDOCIOUS: {
    effect: 'instant_win',
    description: 'Validly on your board, it wins the game on the spot.',
  },
  GHOST: { effect: 'ghost', description: 'Opponents see your tile count as ?? for the rest of the game.' },
  FREEZE: { effect: 'freeze', description: 'Timed solo only: the clock stops for 10 seconds, once per game.' },
};

const EGG_SET: ReadonlySet<string> = new Set(EASTER_EGG_WORDS);

/** Strict: grid words are always uppercase (extractWords), so lowercase never matches here. */
export function isEasterEggWord(word: string): word is EggWord {
  return EGG_SET.has(word);
}

/** The egg words in `words`, deduped, in EASTER_EGG_WORDS order. */
export function eggWordsIn(words: Iterable<string>): EggWord[] {
  const present = new Set(words);
  return EASTER_EGG_WORDS.filter((w) => present.has(w));
}

/** Eggs in `present` that have not fired yet — the pure core of useEasterEggs' trigger-once rule. */
export function newlyFoundEggs(present: Iterable<string>, fired: ReadonlySet<string>): EggWord[] {
  return eggWordsIn(present).filter((w) => !fired.has(w));
}

/** Every letter of `sub` appears in `sup` at least as many times. Compared per letter, never by
 * summing (the same trap grid.ts's multisetsEqual documents). */
export function isSubMultiset(sub: Record<string, number>, sup: Record<string, number>): boolean {
  for (const [letter, n] of Object.entries(sub)) {
    if (n > (sup[letter] ?? 0)) return false;
  }
  return true;
}

export type SupercaliInvalidReason = 'EMPTY_GRID' | 'EXTRA_TILES' | 'NOT_CONNECTED' | 'ORPHAN_TILE' | 'NO_SUPERCALI';

export interface SupercaliResult {
  valid: boolean;
  reason?: SupercaliInvalidReason;
  words: string[];
  orphans: string[];
}

/**
 * Structural check for a Supercali win. Same as validateStructure except the grid's letters need
 * only be a SUB-multiset of the rack (other tiles may still be in hand), and the grid must contain
 * SUPERCALI as a whole word (a maximal run). Dictionary validity of the other words is checked
 * separately by the caller (Worker → find_invalid_words).
 */
export function validateSupercaliStructure(grid: GridState, rack: Letter[]): SupercaliResult {
  const words = extractWords(grid);
  const orphans = findOrphans(grid);
  if (Object.keys(grid).length === 0) return { valid: false, reason: 'EMPTY_GRID', words, orphans };
  if (!isSubMultiset(gridLetters(grid), letterMultiset(rack))) {
    return { valid: false, reason: 'EXTRA_TILES', words, orphans };
  }
  if (!isConnected(grid)) return { valid: false, reason: 'NOT_CONNECTED', words, orphans };
  if (orphans.length > 0) return { valid: false, reason: 'ORPHAN_TILE', words, orphans };
  if (!words.includes(SUPERCALI)) return { valid: false, reason: 'NO_SUPERCALI', words, orphans };
  return { valid: true, words, orphans };
}

/** Upper bound on a submitted eggs_found list: generous headroom for future eggs, rejects garbage. */
const MAX_EGGS_FOUND = 32;

/** Validates a client-reported `eggs_found` list. Returns the canonical (uppercased, deduped,
 * EASTER_EGG_WORDS-ordered) list, or null if the payload is malformed or names a non-egg. */
export function sanitizeEggsFound(input: unknown): EggWord[] | null {
  if (!Array.isArray(input) || input.length > MAX_EGGS_FOUND) return null;
  const upper: string[] = [];
  for (const e of input) {
    if (typeof e !== 'string') return null;
    const u = e.toUpperCase();
    if (!isEasterEggWord(u)) return null;
    upper.push(u);
  }
  return eggWordsIn(upper);
}
