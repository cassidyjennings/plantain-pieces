import { BUNCH_SIZE_PRESETS } from '@plantain/shared';
import type { GameMode, ProfileStatsRow } from './profile.js';

/** The Stats tab's mode pills: one per profile_stats mode, plus 'all' (client-side aggregate). */
export type StatsFilter = 'all' | GameMode;

/** Account-wide daily play streak (lives on profiles, not profile_stats). */
export interface StreakInfo {
  current: number;
  longest: number;
}

export interface StatTileDef {
  label: string;
  /** Filters this tile is shown on. A tile that can never carry information on a mode is hidden
   * there instead of showing a permanent '-' or 0. */
  modes: readonly StatsFilter[];
  value: (stats: ProfileStatsRow, streak: StreakInfo | null) => string | number;
}

export interface StatTile {
  label: string;
  value: string | number;
}

const EVERY: readonly StatsFilter[] = ['all', 'multiplayer', 'solo', 'daily'];
// Win rate and peel streak are multiplayer-only by definition (best_peel_streak is never set for
// solo/xtina rows) -- see the 2026-08-08 spec.
const COMPETITIVE: readonly StatsFilter[] = ['all', 'multiplayer'];
// Daily deals the whole puzzle at once (Bunch starts at 0) and has Dump off, so peel/dump tiles
// can never move off zero there -- 2026-10-06 spec, section 1.1.
const DRAWS: readonly StatsFilter[] = ['all', 'multiplayer', 'solo'];
// Best time per Bunch size: solo-only (multiplayer has no clock, daily has no Bunch).
const SOLO_CLOCK: readonly StatsFilter[] = ['all', 'solo'];
// Best time is safe on 'all' (min is associative). Average is daily-only: on 'all', games_played
// is summed across every mode, so dividing daily_total_time_ms by it would be silently wrong --
// see the 2026-09-24 design doc.
const DAILY_BEST: readonly StatsFilter[] = ['all', 'daily'];
const DAILY_ONLY: readonly StatsFilter[] = ['daily'];

/** mm:ss, matching Game.tsx's Timed solo elapsed-time card and Results.tsx's summary. */
export function formatBestTime(ms: number | undefined): string {
  if (ms == null) return '-';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function favoriteLetters(stats: ProfileStatsRow): string {
  const letterEntries = Object.entries(stats.first_letter_counts ?? {});
  const maxLetterCount = letterEntries.reduce((max, [, count]) => Math.max(max, count), 0);
  if (maxLetterCount === 0) return '-';
  const tiedLetters = letterEntries
    .filter(([, count]) => count === maxLetterCount)
    .map(([letter]) => letter)
    .sort();
  return tiedLetters.length > 4
    ? `${tiedLetters.slice(0, 4).join(', ')} +${tiedLetters.length - 4}`
    : tiedLetters.join(', ');
}

/** Every Stats-tab tile in display order. Visibility per mode lives on the tile itself. */
export const STAT_TILE_DEFS: readonly StatTileDef[] = [
  { label: 'Games played', modes: EVERY, value: (s) => s.games_played },
  {
    label: 'Wins',
    modes: COMPETITIVE,
    value: (s) => `${s.games_won} (${s.games_played > 0 ? Math.round((s.games_won / s.games_played) * 100) : 0}%)`,
  },
  { label: 'Current streak', modes: EVERY, value: (_s, streak) => streak?.current ?? '-' },
  { label: 'Longest streak', modes: EVERY, value: (_s, streak) => streak?.longest ?? '-' },
  { label: 'Longest word', modes: EVERY, value: (s) => s.longest_word ?? '-' },
  { label: 'Rarest word', modes: EVERY, value: (s) => s.rarest_word ?? '-' },
  {
    label: 'Avg word length',
    modes: EVERY,
    value: (s) => (s.total_words > 0 ? (s.total_word_length / s.total_words).toFixed(1) : '-'),
  },
  {
    label: 'Fastest peel',
    modes: DRAWS,
    value: (s) => (s.fastest_peel_ms != null ? `${(s.fastest_peel_ms / 1000).toFixed(1)}s` : '-'),
  },
  { label: 'Tiles peeled', modes: DRAWS, value: (s) => s.total_peels },
  { label: 'Tiles dumped', modes: DRAWS, value: (s) => s.total_dumps },
  { label: 'Favorite starting letter', modes: EVERY, value: favoriteLetters },
  {
    label: 'Best peel streak',
    modes: COMPETITIVE,
    value: (s) => ((s.best_peel_streak ?? 0) > 0 ? s.best_peel_streak : '-'),
  },
  ...BUNCH_SIZE_PRESETS.map(
    (preset): StatTileDef => ({
      label: `Best time · ${preset.label}`,
      modes: SOLO_CLOCK,
      value: (s) => formatBestTime(s.solo_best_times?.[String(preset.size)]),
    }),
  ),
  {
    label: 'Best time (daily)',
    modes: DAILY_BEST,
    value: (s) => formatBestTime(s.daily_best_time_ms ?? undefined),
  },
  {
    label: 'Average time (daily)',
    modes: DAILY_ONLY,
    value: (s) => (s.games_played > 0 ? formatBestTime(s.daily_total_time_ms / s.games_played) : '-'),
  },
];

/** The tiles shown on a filter. Data-free, so the loading skeleton can size itself from it. */
export function visibleStatTiles(filter: StatsFilter): StatTileDef[] {
  return STAT_TILE_DEFS.filter((def) => def.modes.includes(filter));
}

export function buildStatTiles(
  stats: ProfileStatsRow,
  streak: StreakInfo | null,
  filter: StatsFilter,
): StatTile[] {
  return visibleStatTiles(filter).map((def) => ({ label: def.label, value: def.value(stats, streak) }));
}
