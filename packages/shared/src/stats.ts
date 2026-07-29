import { WORD_PATTERN } from './dictionary.js';

/** How many of a player's subsequent moves count as "soon" when deciding whether a dumped
 * tile would have completed a word (dump-regret lookahead). */
export const DUMP_REGRET_LOOKAHEAD = 3;

/** A placed tile that waited at least this many of the player's moves between being drawn
 * and being placed counts as having "sat idle" (idle-tile ratio). */
export const IDLE_MOVE_THRESHOLD = 8;

/** Rarity threshold (inclusive) for the Word Nerd achievement / "rare word" tagging, on the
 * wordRarity() proxy scale below. Long words and rare-letter words clear it. */
export const WORD_NERD_THRESHOLD = 30;

/**
 * Per-letter scarcity weight — a rarity PROXY derived from the 144-tile Bananagrams
 * distribution (rarer letter = fewer tiles = higher weight), NOT a corpus frequency.
 * weight = round(18 / tileCount), where 18 (E) is the most common. Kept as an explicit
 * table so the SQL mirror (`word_rarity` RPC) can hardcode identical values.
 */
export const LETTER_RARITY: Record<string, number> = {
  E: 1, A: 1, I: 2, O: 2, N: 2, R: 2, T: 2, S: 3, D: 3, U: 3, L: 4, G: 5,
  B: 6, C: 6, F: 6, H: 6, M: 6, P: 6, V: 6, W: 6, Y: 6, J: 9, K: 9, Q: 9, X: 9, Z: 9,
};

/** Rarity score of a word = sum of its letters' scarcity weights. Deterministic proxy used
 * for "rarest word played" and the Word Nerd achievement. Non-letters contribute 0. */
export function wordRarity(word: string): number {
  let score = 0;
  for (const ch of word.toUpperCase()) score += LETTER_RARITY[ch] ?? 0;
  return score;
}

// --- Client end-of-game summary --------------------------------------------------------

export interface MoveStats {
  /** Avg number of the player's moves between drawing a tile and placing it (peel
   * efficiency). null if no tile was ever placed. */
  peelEfficiency: number | null;
  /** Fraction (0..1) of finally-placed tiles that sat idle >= IDLE_MOVE_THRESHOLD moves
   * before placement. null if no tile was placed. */
  idleTileRatio: number | null;
  /** Count of dumped tiles that would have completed a word within the next
   * DUMP_REGRET_LOOKAHEAD moves (caller determines regret with board context). */
  dumpRegret: number;
}

/** The per-player summary the client submits at game end. Server stores it with loose
 * bounds-checking (validateGameSummary) — it is casual, not trusted. */
export interface GameSummary {
  /** Words in the player's final grid, uppercase. */
  words: string[];
  /** Number of tiles placed on the final grid. */
  placedCount: number;
  moveStats: MoveStats;
}

export interface TileLifecycle {
  /** Move index (0-based, in the player's own move sequence) when the tile entered the rack. */
  drawnAtMove: number;
  /** Move index when it was placed, or null if it was never placed. */
  placedAtMove: number | null;
}

export interface DumpRecord {
  /** Caller-determined: would this dumped tile have completed a word within the lookahead? */
  regretful: boolean;
}

export interface MoveLog {
  tiles: TileLifecycle[];
  dumps: DumpRecord[];
}

/** Pure reduction of a client-side move log into the three move-level stats. The hard
 * board analysis (which dumps were regretful) is done by the caller and passed in via
 * DumpRecord.regretful, keeping this deterministic and testable. */
export function computeMoveStats(log: MoveLog): MoveStats {
  const placed = log.tiles.filter((t) => t.placedAtMove !== null);
  let peelEfficiency: number | null = null;
  let idleTileRatio: number | null = null;
  if (placed.length > 0) {
    const waits = placed.map((t) => (t.placedAtMove as number) - t.drawnAtMove);
    peelEfficiency = waits.reduce((a, b) => a + b, 0) / placed.length;
    const idle = waits.filter((w) => w >= IDLE_MOVE_THRESHOLD).length;
    idleTileRatio = idle / placed.length;
  }
  const dumpRegret = log.dumps.filter((d) => d.regretful).length;
  return { peelEfficiency, idleTileRatio, dumpRegret };
}

// --- Loose server-side validation of a submitted summary -------------------------------

/** Sane ceiling on how many distinct words / placed tiles a summary can claim. A full
 * 144-tile grid has far fewer words than this; it only exists to reject garbage. */
const MAX_SUMMARY_WORDS = 400;
const MAX_SUMMARY_TILES = 200;

export type GameSummaryValidity =
  | { valid: true }
  | { valid: false; reason: 'MALFORMED' | 'OUT_OF_RANGE' | 'INVALID_WORD' };

/** Loosely validates a client-submitted GameSummary. Optionally cross-checks placedCount
 * against the server-known final tile count. Deliberately permissive — this is a casual
 * game; the goal is only to reject malformed or absurd payloads, not to prevent cheating. */
export function validateGameSummary(
  summary: unknown,
  ctx?: { finalTileCount?: number },
): GameSummaryValidity {
  if (typeof summary !== 'object' || summary === null) return { valid: false, reason: 'MALFORMED' };
  const s = summary as Record<string, unknown>;

  if (!Array.isArray(s.words)) return { valid: false, reason: 'MALFORMED' };
  if (s.words.length > MAX_SUMMARY_WORDS) return { valid: false, reason: 'OUT_OF_RANGE' };
  for (const w of s.words) {
    if (typeof w !== 'string' || !WORD_PATTERN.test(w)) return { valid: false, reason: 'INVALID_WORD' };
  }

  if (!Number.isInteger(s.placedCount) || (s.placedCount as number) < 0) {
    return { valid: false, reason: 'MALFORMED' };
  }
  if ((s.placedCount as number) > MAX_SUMMARY_TILES) return { valid: false, reason: 'OUT_OF_RANGE' };
  if (ctx?.finalTileCount !== undefined && (s.placedCount as number) > ctx.finalTileCount) {
    return { valid: false, reason: 'OUT_OF_RANGE' };
  }

  const ms = s.moveStats;
  if (typeof ms !== 'object' || ms === null) return { valid: false, reason: 'MALFORMED' };
  const m = ms as Record<string, unknown>;
  const numOrNullInRange = (v: unknown, min: number, max: number) =>
    v === null || (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max);
  if (!numOrNullInRange(m.peelEfficiency, 0, 10000)) return { valid: false, reason: 'OUT_OF_RANGE' };
  if (!numOrNullInRange(m.idleTileRatio, 0, 1)) return { valid: false, reason: 'OUT_OF_RANGE' };
  if (!Number.isInteger(m.dumpRegret) || (m.dumpRegret as number) < 0 || (m.dumpRegret as number) > MAX_SUMMARY_TILES) {
    return { valid: false, reason: 'OUT_OF_RANGE' };
  }

  return { valid: true };
}
