import { extractWordsWithCells, type AvatarConfig, type GridState } from '@plantain/shared';
import { supabase } from './supabase.js';

/** Every participant's final board for a finished game. Read directly via RLS — the
 * game_boards_public view does its own authorization (is_game_participant), so there's no
 * Worker round-trip here, same pattern as my_match_history / custom_word_sets_with_count. */
export interface GameBoardRow {
  game_id: string;
  profile_id: string;
  display_name: string;
  seat: number;
  is_winner: boolean;
  final_tile_count: number;
  final_placed_count: number | null;
  final_grid: GridState;
  longest_word: string | null;
  /** Dictionary-VALID words only — submit_game_summary filters them (migration …0002). */
  words_played: string[];
  avatar_config: AvatarConfig;
}

export async function fetchGameBoards(gameId: string): Promise<GameBoardRow[]> {
  const { data, error } = await supabase
    .from('game_boards_public')
    .select('*')
    .eq('game_id', gameId)
    .order('seat');
  if (error) return [];
  return (data ?? []) as GameBoardRow[];
}

/**
 * Cells to tint green: those belonging to a dictionary-valid word. `words_played` is already
 * filtered server-side by submit_game_summary, so no dictionary lookup is needed here — which
 * is what makes this possible at all, since the room (and its dictionary config) may be long
 * gone by the time anyone opens the viewer.
 *
 * Mirrors the in-game rule exactly: a cell where a valid and an invalid word CROSS does not
 * tint. Tinting it would let an invalid word hide behind the valid words crossing it — the
 * same bug that once let auto-Peel fire on a board with a bad word still on it.
 *
 * Shared by the Results preview and the full viewer so the two can't drift apart.
 */
export function validCellsFor(row: Pick<GameBoardRow, 'final_grid' | 'words_played'> | null): Set<string> {
  const empty = new Set<string>();
  if (!row) return empty;
  const played = new Set(row.words_played ?? []);
  if (played.size === 0) return empty;

  const words = extractWordsWithCells(row.final_grid ?? {});
  const bad = new Set<string>();
  for (const w of words) {
    if (!played.has(w.word)) for (const c of w.cells) bad.add(c);
  }
  const good = new Set<string>();
  for (const w of words) {
    if (played.has(w.word)) for (const c of w.cells) if (!bad.has(c)) good.add(c);
  }
  return good;
}
