import { extractWordsWithCells, type AvatarConfig, type GridState } from '@plantain/shared';
import { supabase } from './supabase.js';
import { api } from './api.js';

/**
 * Every player's final board for a FINISHED room. Read directly via RLS — room_boards_public
 * does its own authorization (is_room_member + status = 'finished'), so there's no Worker
 * round-trip, same pattern as room_players_public.
 *
 * These boards are ephemeral: they live on room_players and are deleted along with the room.
 * There is deliberately no archived copy — see migration 20260728000005.
 */
export interface RoomBoardRow {
  room_id: string;
  profile_id: string;
  display_name: string;
  seat: number;
  is_winner: boolean;
  tile_count: number;
  grid_state: GridState;
  avatar_config: AvatarConfig;
}

export async function fetchRoomBoards(roomId: string): Promise<RoomBoardRow[]> {
  const { data, error } = await supabase
    .from('room_boards_public')
    .select('*')
    .eq('room_id', roomId)
    .order('seat');
  if (error) return [];
  return (data ?? []) as RoomBoardRow[];
}

export interface BoardWords {
  /** Cell keys belonging to a dictionary-valid word — tinted green, same cue as in-game. */
  validCells: Set<string>;
  /** The valid words on this board, in reading order. */
  words: string[];
}

export const EMPTY_BOARD_WORDS: BoardWords = { validCells: new Set(), words: [] };

/**
 * Work out which words a finished board actually scored, by extracting them from the grid and
 * checking them against the room's dictionary through the existing /validate endpoint.
 *
 * Derived rather than stored: the durable words_played column exists for stats, but relying on
 * it here would mean the viewer only worked for players whose client submitted a summary. The
 * room is alive whenever this screen is reachable (that's the view's own precondition), so its
 * dictionary is too.
 *
 * The cross-word rule mirrors the in-game one exactly: a cell where a valid and an invalid word
 * CROSS does not tint. Tinting it would let an invalid word hide behind the valid words
 * crossing it — the same bug that once let auto-Peel fire on a board with a bad word on it.
 */
export async function resolveBoardWords(roomId: string, grid: GridState): Promise<BoardWords> {
  const found = extractWordsWithCells(grid ?? {});
  if (found.length === 0) return EMPTY_BOARD_WORDS;

  const unique = [...new Set(found.map((w) => w.word))];
  let invalid: Set<string>;
  try {
    const { invalidWords } = await api.validate(roomId, unique);
    invalid = new Set(invalidWords);
  } catch {
    // Transient failure — better to show the board with no tinting than to fail the screen.
    return EMPTY_BOARD_WORDS;
  }

  const bad = new Set<string>();
  for (const w of found) {
    if (invalid.has(w.word)) for (const c of w.cells) bad.add(c);
  }
  const validCells = new Set<string>();
  const words: string[] = [];
  for (const w of found) {
    if (invalid.has(w.word)) continue;
    words.push(w.word);
    for (const c of w.cells) if (!bad.has(c)) validCells.add(c);
  }
  return { validCells, words };
}
