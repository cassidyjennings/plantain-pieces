import {
  type AvatarConfig,
  type AchievementType,
  DEFAULT_AVATAR_CONFIG,
  normalizeAvatarConfig,
} from '@plantain/shared';
import { supabase } from './supabase.js';
import { fetchMyCustomWordSets } from './dictionaries.js';
import { aggregateStats } from './statsView.js';

/** Owner-scoped reads gated by RLS (no Worker round-trip) — mirrors lib/dictionaries.ts.
 * Writes (update/delete/summary) go through the Worker; see lib/api.ts. */

export type GameMode = 'multiplayer' | 'solo' | 'daily';

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
  /** 'owner' may arm xtina mode; 'partner' is the account its scripted deal targets.
   * Null for every ordinary account, which is everyone. */
  xtina_role: 'owner' | 'partner' | null;
  /** Whether xtina mode is armed. Only meaningful on an owner row. */
  xtina_enabled: boolean;
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
  best_peel_streak: number;
  first_letter_counts: Record<string, number>;
  /** Solo mode only (empty on every multiplayer/xtina row): best (lowest) completion ms for a
   * Timed solo win, keyed by bunch size as a string, e.g. { "54": 143000 }. */
  solo_best_times: Record<string, number>;
  /** Daily challenge only (null/0 on every other mode's row). Average is total/games_played,
   * computed at render time — no stored average column. */
  daily_best_time_ms: number | null;
  daily_total_time_ms: number;
}

export interface AchievementRow {
  type: AchievementType;
  earned_at: string;
  meta: Record<string, unknown>;
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

/** Every profile_stats row the caller owns, one per mode played. Empty when signed out, never
 * played, or the read failed; the Stats tab treats all three as "no games yet". */
export async function fetchMyStatsRows(): Promise<ProfileStatsRow[]> {
  const id = await myId();
  if (!id) return [];
  const { data, error } = await supabase.from('profile_stats').select('*').eq('profile_id', id);
  if (error) return [];
  return data as ProfileStatsRow[];
}

/** Aggregate across all of the caller's mode rows ("All modes"). */
export async function fetchMyStats(): Promise<ProfileStatsRow | null> {
  return aggregateStats(await fetchMyStatsRows());
}

/** Same auto-name shape handle_new_user() stamps on every fresh auth user. */
const AUTO_GUEST_NAME = /^Guest-[0-9a-f]{4}$/i;

/**
 * Does the current guest hold anything that would be lost by signing in as a different account?
 *
 * Drives the sign-in strategy: with progress we attempt an identity LINK (keeps this guest row
 * and everything on it), which is worth it despite costing a second OAuth round-trip when the
 * Google account turns out to already exist. Without progress a plain sign-in is strictly
 * better — one account-picker click, and the empty guest is simply abandoned.
 *
 * Reads the SERVER's display_name deliberately, not the store's: the store falls back to an
 * origin-wide localStorage cache that a returning user carries between tabs, so trusting it
 * would make nearly every fresh guest look like it had progress and reintroduce the double
 * prompt this check exists to remove.
 */
export async function guestHasProgress(): Promise<boolean> {
  const [profile, stats, sets] = await Promise.all([
    fetchMyProfile(),
    fetchMyStats(),
    fetchMyCustomWordSets().catch(() => []),
  ]);
  if (!profile) return false;
  if ((stats?.games_played ?? 0) > 0) return true;
  if (sets.length > 0) return true;
  if (!AUTO_GUEST_NAME.test(profile.display_name)) return true;
  const avatar = normalizeAvatarConfig(profile.avatar_config);
  return (['base', 'hat', 'glasses', 'hair'] as const).some(
    (slot) => avatar[slot] !== DEFAULT_AVATAR_CONFIG[slot],
  );
}

export async function fetchMyAchievements(): Promise<AchievementRow[]> {
  const { data, error } = await supabase.from('achievements').select('type, earned_at, meta');
  if (error) return [];
  return data as AchievementRow[];
}

