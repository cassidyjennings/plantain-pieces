import {
  type AvatarConfig,
  type AchievementType,
  DEFAULT_AVATAR_CONFIG,
  normalizeAvatarConfig,
} from '@plantain/shared';
import { supabase } from './supabase.js';
import { fetchMyCustomWordSets } from './dictionaries.js';

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

/** Merges multiple per-mode rows into one aggregate: sums the additive counters, min/max the
 * extremal ones, and unions first_letter_counts. Used for the Stats tab's default "All modes" view. */
function aggregateStats(rows: ProfileStatsRow[]): ProfileStatsRow | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];

  let longest: ProfileStatsRow['longest_word'] = null;
  let longestLen = 0;
  let rarest: ProfileStatsRow['rarest_word'] = null;
  let rarestScore = 0;
  let fastestPeel: number | null = null;
  let bestStreak = 0;
  const letterCounts: Record<string, number> = {};
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
    bestStreak = Math.max(bestStreak, r.best_peel_streak);
    for (const [letter, count] of Object.entries(r.first_letter_counts)) {
      letterCounts[letter] = (letterCounts[letter] ?? 0) + count;
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
    best_peel_streak: bestStreak,
    first_letter_counts: letterCounts,
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

