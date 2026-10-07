import { describe, it, expect } from 'vitest';
import { buildStatTiles, formatBestTime, visibleStatTiles, type StatsFilter } from '../src/lib/statTiles.js';
import { statsRow } from './fixtures.js';

const labels = (filter: StatsFilter) => visibleStatTiles(filter).map((t) => t.label);

describe('visibleStatTiles', () => {
  it('daily shows exactly the nine tiles that can carry information', () => {
    expect(labels('daily')).toEqual([
      'Games played',
      'Current streak',
      'Longest streak',
      'Longest word',
      'Rarest word',
      'Avg word length',
      'Favorite starting letter',
      'Best time (daily)',
      'Average time (daily)',
    ]);
  });

  it('daily hides the peel, dump and per-Bunch-size tiles', () => {
    const daily = labels('daily');
    for (const hidden of [
      'Fastest peel',
      'Tiles peeled',
      'Tiles dumped',
      'Best time · Quick',
      'Best time · Standard',
      'Best time · Full',
    ]) {
      expect(daily).not.toContain(hidden);
    }
  });

  it('solo keeps its existing tile set', () => {
    expect(labels('solo')).toEqual([
      'Games played',
      'Current streak',
      'Longest streak',
      'Longest word',
      'Rarest word',
      'Avg word length',
      'Fastest peel',
      'Tiles peeled',
      'Tiles dumped',
      'Favorite starting letter',
      'Best time · Quick',
      'Best time · Standard',
      'Best time · Full',
    ]);
  });

  it('multiplayer keeps its existing tile set', () => {
    expect(labels('multiplayer')).toEqual([
      'Games played',
      'Wins',
      'Current streak',
      'Longest streak',
      'Longest word',
      'Rarest word',
      'Avg word length',
      'Fastest peel',
      'Tiles peeled',
      'Tiles dumped',
      'Favorite starting letter',
      'Best peel streak',
    ]);
  });

  it('all keeps its existing tile set', () => {
    expect(labels('all')).toEqual([
      'Games played',
      'Wins',
      'Current streak',
      'Longest streak',
      'Longest word',
      'Rarest word',
      'Avg word length',
      'Fastest peel',
      'Tiles peeled',
      'Tiles dumped',
      'Favorite starting letter',
      'Best peel streak',
      'Best time · Quick',
      'Best time · Standard',
      'Best time · Full',
      'Best time (daily)',
    ]);
  });
});

describe('buildStatTiles', () => {
  const valueOf = (tiles: { label: string; value: string | number }[], label: string) =>
    tiles.find((t) => t.label === label)?.value;

  it('computes daily best and average time', () => {
    const tiles = buildStatTiles(
      statsRow({ mode: 'daily', games_played: 2, daily_best_time_ms: 100_000, daily_total_time_ms: 250_000 }),
      { current: 3, longest: 5 },
      'daily',
    );
    expect(valueOf(tiles, 'Best time (daily)')).toBe('1:40');
    expect(valueOf(tiles, 'Average time (daily)')).toBe('2:05');
    expect(valueOf(tiles, 'Current streak')).toBe(3);
    expect(valueOf(tiles, 'Longest streak')).toBe(5);
  });

  it('shows a dash for the streak tiles when the profile read failed', () => {
    const tiles = buildStatTiles(statsRow({ games_played: 1 }), null, 'all');
    expect(valueOf(tiles, 'Current streak')).toBe('-');
    expect(valueOf(tiles, 'Longest streak')).toBe('-');
  });

  it('lists tied favorite letters alphabetically, capped at four', () => {
    const tiles = buildStatTiles(
      statsRow({ games_played: 1, first_letter_counts: { E: 3, B: 3, A: 3, D: 3, C: 3, F: 1 } }),
      null,
      'all',
    );
    expect(valueOf(tiles, 'Favorite starting letter')).toBe('A, B, C, D +1');
  });

  it('formats win rate and fastest peel', () => {
    const tiles = buildStatTiles(
      statsRow({ games_played: 4, games_won: 1, fastest_peel_ms: 2340 }),
      null,
      'multiplayer',
    );
    expect(valueOf(tiles, 'Wins')).toBe('1 (25%)');
    expect(valueOf(tiles, 'Fastest peel')).toBe('2.3s');
  });
});

describe('formatBestTime', () => {
  it('renders mm:ss and a dash for a missing time', () => {
    expect(formatBestTime(143_000)).toBe('2:23');
    expect(formatBestTime(undefined)).toBe('-');
  });
});
