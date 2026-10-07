import type { PublicRoom } from './rooms.js';

/** Which of the Results page's mode-dependent fetches run. Everything not listed here (players,
 * boards) runs for every mode, starting on mount. */
export interface ResultsFetchPlan {
  /** Read this player's achievements for ones unlocked by this room. */
  achievements: boolean;
  /** Delays (ms) of the re-reads after the immediate one; the last is final. */
  achievementRechecksMs: readonly number[];
  /** Fetch the daily beat-percent / personal-best summary. */
  dailySummary: boolean;
}

export function resultsFetchPlan(mode: PublicRoom['mode']): ResultsFetchPlan {
  if (mode === 'daily') {
    // Every achievement the re-poll could surface is peel/dump/opponent based, and a daily game
    // has no Bunch to peel, no Dump and no opponent -- 2026-10-06 spec, section 1.4.
    return { achievements: false, achievementRechecksMs: [], dailySummary: true };
  }
  // Re-checks catch the word-based achievements the client's own summary (submitSummaryOnce in
  // Game.tsx) lands a beat after the game ends -- usually well under a second.
  return { achievements: true, achievementRechecksMs: [400, 1000], dailySummary: false };
}
