/** Shared domain types for Plantain Pieces. */

/** A single uppercase letter A–Z. Tiles carry only a letter (no blanks in Bananagrams). */
export type Letter = string;

/** Map of letter -> remaining count in the Bunch. */
export type LetterCounts = Record<Letter, number>;

/** A tile placed on the grid at integer cell coordinates. */
export interface PlacedTile {
  x: number;
  y: number;
  letter: Letter;
}

/**
 * A player's grid: a sparse map of "x,y" -> letter. Using a string-keyed map keeps
 * it JSON-serializable for storage in Postgres jsonb and transport over the wire.
 */
export type GridState = Record<string, Letter>;

/** A player's un-placed tiles (their "rack"/hand), as a flat list of letters. */
export type Rack = Letter[];

export type RoomStatus = 'lobby' | 'active' | 'finished';

/**
 * Per-room dictionary configuration. Topic filtering is stubbed until tagged data exists.
 *
 * A wordlist is one **base** dictionary plus any number of **additional** ones. The accepted
 * words are the union of all of them — base vs additional is a modelling/UI distinction, not a
 * filtering one, which is why `customSetIds` alone still drives `find_invalid_words`.
 * The base is either the built-in ENABLE1 list (`baseEnabled`, `baseSetId: null`) or one of the
 * player's own custom sets (`baseSetId`, which is ALSO listed in `customSetIds` so the union
 * stays correct without the SQL needing to know about bases at all).
 */
export interface DictionaryConfig {
  /** Minimum word length allowed (inclusive). Bananagrams default is 2. */
  minLength: number;
  /** Maximum word length allowed (inclusive), or null for no upper bound. */
  maxLength: number | null;
  /** Whether the built-in ENABLE1 list is included (and, when baseSetId is null, is the base). */
  baseEnabled: boolean;
  /** Topic tags to exclude (no-op until words are topic-tagged). */
  excludedTopics: string[];
  /** Every custom word set included — the custom base (if any) plus the additional ones. */
  customSetIds: string[];
  /** The custom set serving as the base, or null when the base is the built-in list. */
  baseSetId?: string | null;
}

export const DEFAULT_DICTIONARY_CONFIG: DictionaryConfig = {
  minLength: 2,
  maxLength: null,
  baseEnabled: true,
  excludedTopics: [],
  customSetIds: [],
  baseSetId: null,
};

/** Reasons a grid can fail structural validation. */
export type GridInvalidReason =
  | 'EMPTY_GRID'
  | 'TILES_REMAINING'
  | 'EXTRA_TILES'
  | 'NOT_CONNECTED'
  | 'ORPHAN_TILE'
  | 'INVALID_WORDS';

export interface StructuralResult {
  valid: boolean;
  reason?: GridInvalidReason;
  /** All words (length >= 2 runs) extracted from the grid, uppercase. */
  words: string[];
  /** Coordinates ("x,y") of any tile not part of a horizontal/vertical word. */
  orphans: string[];
  /** Words that were not found in the dictionary (populated only by full validation). */
  invalidWords?: string[];
}
