/**
 * Display logic for the daily puzzle's Results "Your game" tiles. Kept pure (and here, rather
 * than in apps/web) so it is unit-tested; apps/web has no test runner.
 */

/** The fields of the Worker's `/daily/:puzzleId/result-summary` reply these helpers read. */
export interface DailySummaryLike {
  available: boolean;
  beatPercent?: number | null;
  isPersonalBest?: boolean;
}

/** `ms` as `M:SS`, seconds floored. */
export function formatDurationMs(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * The Solvers beaten tile's value, or `null` while it should still show a skeleton.
 *
 * `available: false` means this player's daily_results row isn't written yet (archive_game runs
 * async after the game), so it keeps the skeleton until the caller's final retry has `settled`.
 * `beatPercent` is null exactly when this player is the only solver so far.
 */
export function solversBeatenLabel(summary: DailySummaryLike | null, settled: boolean): string | null {
  if (summary?.available) {
    return summary.beatPercent == null ? 'First!' : `${summary.beatPercent}%`;
  }
  return settled ? '-' : null;
}

/** Whether the Time tile carries the "Personal Best" badge. */
export function isDailyPersonalBest(summary: DailySummaryLike | null): boolean {
  return summary?.available === true && summary.isPersonalBest === true;
}
