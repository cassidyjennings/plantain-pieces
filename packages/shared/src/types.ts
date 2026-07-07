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

/** Per-room dictionary configuration. Topic filtering is stubbed until tagged data exists. */
export interface DictionaryConfig {
  /** Minimum word length allowed (inclusive). Bananagrams default is 2. */
  minLength: number;
  /** Maximum word length allowed (inclusive), or null for no upper bound. */
  maxLength: number | null;
  /** Whether the base ENABLE1 list is enabled. */
  baseEnabled: boolean;
  /** Topic tags to exclude (no-op until words are topic-tagged). */
  excludedTopics: string[];
  /** Custom word set ids to include in addition to the base list. */
  customSetIds: string[];
}

export const DEFAULT_DICTIONARY_CONFIG: DictionaryConfig = {
  minLength: 2,
  maxLength: null,
  baseEnabled: true,
  excludedTopics: [],
  customSetIds: [],
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
