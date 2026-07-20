import type { AvatarConfig, AchievementType } from '@plantain/shared';
import { supabase } from './supabase.js';

/** Owner-scoped reads gated by RLS (no Worker round-trip) — mirrors lib/dictionaries.ts.
 * Writes (update/delete/summary) go through the Worker; see lib/api.ts. */

export interface ProfileRow {
  id: string;
  display_name: string;
  is_guest: boolean;
  avatar_config: AvatarConfig;
  created_at: string;
}

export interface ProfileStatsRow {
  profile_id: string;
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
  current_streak: number;
  longest_streak: number;
  last_played_date: string | null;
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

export async function fetchMyStats(): Promise<ProfileStatsRow | null> {
  const id = await myId();
  if (!id) return null;
  const { data, error } = await supabase.from('profile_stats').select('*').eq('profile_id', id).maybeSingle();
  if (error) return null;
  return data as ProfileStatsRow | null;
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
