import type { ProfileStatsRow } from './profile.js';
import type { StatsFilter } from './statTiles.js';

/** Merges multiple per-mode rows into one aggregate: sums the additive counters, min/max the
 * extremal ones, and sums first_letter_counts per letter. Used for the Stats tab's default "All
 * modes" view. Pure (no Supabase import) so it's unit-testable. */
export function aggregateStats(rows: readonly ProfileStatsRow[]): ProfileStatsRow | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];

  let longest: ProfileStatsRow['longest_word'] = null;
  let longestLen = 0;
  let rarest: ProfileStatsRow['rarest_word'] = null;
  let rarestScore = 0;
  let fastestPeel: number | null = null;
  let bestStreak = 0;
  const letterCounts: Record<string, number> = {};
  const bestTimes: Record<string, number> = {};
  let dailyBestMs: number | null = null;
  let dailyTotalMs = 0;
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
    bestStreak = Math.max(bestStreak, r.best_peel_streak ?? 0);
    for (const [letter, count] of Object.entries(r.first_letter_counts ?? {})) {
      letterCounts[letter] = (letterCounts[letter] ?? 0) + count;
    }
    // Only the 'solo' row ever populates this, but merging key-wise (min) rather than just
    // taking that row means no mode-specific branch is needed here either.
    for (const [bunchSize, ms] of Object.entries(r.solo_best_times ?? {})) {
      bestTimes[bunchSize] = bestTimes[bunchSize] != null ? Math.min(bestTimes[bunchSize], ms) : ms;
    }
    if (r.daily_best_time_ms != null) {
      dailyBestMs = dailyBestMs == null ? r.daily_best_time_ms : Math.min(dailyBestMs, r.daily_best_time_ms);
    }
    dailyTotalMs += r.daily_total_time_ms ?? 0;
  }

  return {
    profile_id: rows[0].profile_id,
    mode: 'multiplayer', // placeholder -- callers requesting the aggregate ignore this field
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
    solo_best_times: bestTimes,
    daily_best_time_ms: dailyBestMs,
    daily_total_time_ms: dailyTotalMs,
  };
}

/** The Stats tab's view for one pill, derived synchronously from every row the caller owns:
 * the aggregate for 'all', otherwise that mode's own row (null if never played). Switching pills
 * is therefore a pure recompute, with no fetch and so no out-of-order reply to race. */
export function deriveStatsView(
  rows: readonly ProfileStatsRow[],
  filter: StatsFilter,
): ProfileStatsRow | null {
  if (filter === 'all') return aggregateStats(rows);
  return rows.find((r) => r.mode === filter) ?? null;
}
