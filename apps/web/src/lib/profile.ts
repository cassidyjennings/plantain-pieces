import type { AvatarConfig, AchievementType, SoloModeConfig } from '@plantain/shared';
import { supabase } from './supabase.js';

/** Owner-scoped reads gated by RLS (no Worker round-trip) — mirrors lib/dictionaries.ts.
 * Writes (update/delete/summary) go through the Worker; see lib/api.ts. */

export type GameMode = 'multiplayer' | 'solo';

export interface ProfileRow {
  id: string;
  display_name: string;
  is_guest: boolean;
  avatar_config: AvatarConfig;
  created_at: string;
  /** Account-wide (not per-mode) daily play streak — playing either mode keeps it alive. */
  current_streak: number;
  longest_streak: number;
  last_played_date: string | null;
}

export interface ProfileStatsRow {
  profile_id: string;
  mode: GameMode;
  games_played: number;
  games_won: number;
  total_peels: number;
  total_dumps: number;
  total_words: number;
  total_word_length: number;
  longest_word: string | null;
  longest_word_length: number;
  fastest_peel_ms: number | null;
  rarest_word: string | null;
  rarest_word_score: number;
  first_letters: string;
  choke_count: number;
}

export interface AchievementRow {
  type: AchievementType;
  earned_at: string;
  meta: Record<string, unknown>;
}

export interface MatchHistoryRow {
  id: string;
  game_id: string;
  is_winner: boolean;
  seat: number;
  final_tile_count: number;
  final_placed_count: number | null;
  peels: number;
  dumps: number;
  longest_word: string | null;
  opponents: { profileId: string; displayName: string; seat: number; isWinner: boolean }[];
  player_count: number;
  spectator_count: number;
  started_at: string | null;
  finished_at: string;
  duration_ms: number | null;
  mode: GameMode;
  mode_config: SoloModeConfig | Record<string, never>;
}

async function myId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

export async function fetchMyProfile(): Promise<ProfileRow | null> {
  const id = await myId();
  if (!id) return null;
  const { data, error } = await supabase.from('profiles').select('*').eq('id', id).single();
  if (error) return null;
  return data as ProfileRow;
}

/** Merges multiple per-mode rows into one aggregate: sums the additive counters, min/max the
 * extremal ones, and unions first_letters. Used for the Stats tab's default "All modes" view. */
function aggregateStats(rows: ProfileStatsRow[]): ProfileStatsRow | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];

  const letterSet = new Set<string>();
  for (const r of rows) for (const ch of r.first_letters) letterSet.add(ch);

  let longest: ProfileStatsRow['longest_word'] = null;
  let longestLen = 0;
  let rarest: ProfileStatsRow['rarest_word'] = null;
  let rarestScore = 0;
  let fastestPeel: number | null = null;
  for (const r of rows) {
    if (r.longest_word_length > longestLen) {
      longestLen = r.longest_word_length;
      longest = r.longest_word;
    }
    if (r.rarest_word_score > rarestScore) {
      rarestScore = r.rarest_word_score;
      rarest = r.rarest_word;
    }
    if (r.fastest_peel_ms != null && (fastestPeel == null || r.fastest_peel_ms < fastestPeel)) {
      fastestPeel = r.fastest_peel_ms;
    }
  }

  return {
    profile_id: rows[0].profile_id,
    mode: 'multiplayer', // placeholder — callers requesting the aggregate ignore this field
    games_played: rows.reduce((sum, r) => sum + r.games_played, 0),
    games_won: rows.reduce((sum, r) => sum + r.games_won, 0),
    total_peels: rows.reduce((sum, r) => sum + r.total_peels, 0),
    total_dumps: rows.reduce((sum, r) => sum + r.total_dumps, 0),
    total_words: rows.reduce((sum, r) => sum + r.total_words, 0),
    total_word_length: rows.reduce((sum, r) => sum + r.total_word_length, 0),
    longest_word: longest,
    longest_word_length: longestLen,
    fastest_peel_ms: fastestPeel,
    rarest_word: rarest,
    rarest_word_score: rarestScore,
    first_letters: [...letterSet].sort().join(''),
    choke_count: rows.reduce((sum, r) => sum + r.choke_count, 0),
  };
}

/** Without a mode, returns the aggregate across all of the profile's mode rows ("All modes",
 * the Stats tab default). With a mode, returns just that row (or null if never played). */
export async function fetchMyStats(mode?: GameMode): Promise<ProfileStatsRow | null> {
  const id = await myId();
  if (!id) return null;
  if (mode) {
    const { data, error } = await supabase
      .from('profile_stats')
      .select('*')
      .eq('profile_id', id)
      .eq('mode', mode)
      .maybeSingle();
    if (error) return null;
    return data as ProfileStatsRow | null;
  }
  const { data, error } = await supabase.from('profile_stats').select('*').eq('profile_id', id);
  if (error) return null;
  return aggregateStats(data as ProfileStatsRow[]);
}

export async function fetchMyAchievements(): Promise<AchievementRow[]> {
  const { data, error } = await supabase.from('achievements').select('type, earned_at, meta');
  if (error) return [];
  return data as AchievementRow[];
}

export async function fetchMyMatchHistory(): Promise<MatchHistoryRow[]> {
  const { data, error } = await supabase
    .from('my_match_history')
    .select('*')
    .order('finished_at', { ascending: false });
  if (error) return [];
  return data as MatchHistoryRow[];
}
