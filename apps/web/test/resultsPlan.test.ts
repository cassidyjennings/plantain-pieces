import { describe, it, expect } from 'vitest';
import { resultsFetchPlan } from '../src/lib/resultsPlan.js';

describe('resultsFetchPlan', () => {
  it('daily skips achievements and their re-polls entirely, and fetches the daily summary', () => {
    expect(resultsFetchPlan('daily')).toEqual({
      achievements: false,
      achievementRechecksMs: [],
      dailySummary: true,
    });
  });

  it.each(['multiplayer', 'solo', 'xtina'] as const)('%s polls achievements at 0/400/1000ms, no daily summary', (mode) => {
    expect(resultsFetchPlan(mode)).toEqual({
      achievements: true,
      achievementRechecksMs: [400, 1000],
      dailySummary: false,
    });
  });
});
