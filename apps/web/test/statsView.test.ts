import { describe, it, expect } from 'vitest';
import { aggregateStats, deriveStatsView } from '../src/lib/statsView.js';
import { statsRow } from './fixtures.js';

const multi = statsRow({
  mode: 'multiplayer',
  games_played: 5,
  games_won: 2,
  total_peels: 30,
  longest_word: 'BANANA',
  longest_word_length: 6,
  fastest_peel_ms: 4000,
});
const solo = statsRow({
  mode: 'solo',
  games_played: 3,
  total_peels: 12,
  longest_word: 'PLANTAINS',
  longest_word_length: 9,
  fastest_peel_ms: 2500,
  solo_best_times: { '54': 143000 },
});

describe('deriveStatsView', () => {
  it("'all' aggregates across every mode row", () => {
    const view = deriveStatsView([multi, solo], 'all');
    expect(view?.games_played).toBe(8);
    expect(view?.total_peels).toBe(42);
    expect(view?.longest_word).toBe('PLANTAINS');
    expect(view?.fastest_peel_ms).toBe(2500);
    expect(view?.solo_best_times).toEqual({ '54': 143000 });
  });

  it('a specific mode returns that mode row unchanged', () => {
    expect(deriveStatsView([multi, solo], 'solo')).toBe(solo);
    expect(deriveStatsView([multi, solo], 'multiplayer')).toBe(multi);
  });

  it('a mode never played is null, not another mode', () => {
    expect(deriveStatsView([multi, solo], 'daily')).toBeNull();
  });

  it('no rows is null for every filter', () => {
    for (const f of ['all', 'multiplayer', 'solo', 'daily'] as const) {
      expect(deriveStatsView([], f)).toBeNull();
    }
  });
});

describe('aggregateStats', () => {
  it('returns a lone row as-is', () => {
    expect(aggregateStats([solo])).toBe(solo);
  });

  it('takes the minimum daily best time and sums daily total time', () => {
    const a = statsRow({ mode: 'daily', daily_best_time_ms: 90000, daily_total_time_ms: 200000 });
    const b = statsRow({ mode: 'solo', daily_best_time_ms: null, daily_total_time_ms: 0 });
    const view = aggregateStats([a, b]);
    expect(view?.daily_best_time_ms).toBe(90000);
    expect(view?.daily_total_time_ms).toBe(200000);
  });
});
