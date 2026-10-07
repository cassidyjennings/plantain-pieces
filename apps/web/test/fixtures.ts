import type { ProfileStatsRow } from '../src/lib/profile.js';

/** A zeroed profile_stats row (every column at its DB default), overridable per test. */
export function statsRow(overrides: Partial<ProfileStatsRow> = {}): ProfileStatsRow {
  return {
    profile_id: '00000000-0000-0000-0000-000000000001',
    mode: 'multiplayer',
    games_played: 0,
    games_won: 0,
    total_peels: 0,
    total_dumps: 0,
    total_words: 0,
    total_word_length: 0,
    longest_word: null,
    longest_word_length: 0,
    fastest_peel_ms: null,
    rarest_word: null,
    rarest_word_score: 0,
    best_peel_streak: 0,
    first_letter_counts: {},
    solo_best_times: {},
    daily_best_time_ms: null,
    daily_total_time_ms: 0,
    ...overrides,
  };
}
