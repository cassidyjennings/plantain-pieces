import { describe, it, expect } from 'vitest';
import { formatDurationMs, solversBeatenLabel, isDailyPersonalBest } from '../src/index.js';

describe('formatDurationMs', () => {
  it('formats minutes and zero-padded seconds', () => {
    expect(formatDurationMs(123_000)).toBe('2:03');
    expect(formatDurationMs(600_000)).toBe('10:00');
  });

  it('floors partial seconds, matching the old inline Results formatting', () => {
    expect(formatDurationMs(59_999)).toBe('0:59');
    expect(formatDurationMs(0)).toBe('0:00');
  });
});

describe('solversBeatenLabel', () => {
  it('is null (skeleton) before any summary has arrived', () => {
    expect(solversBeatenLabel(null, false)).toBeNull();
  });

  it('stays null while the archive row is not written yet and a retry is still pending', () => {
    expect(solversBeatenLabel({ available: false }, false)).toBeNull();
  });

  it('shows a percentage when other solvers exist', () => {
    expect(solversBeatenLabel({ available: true, beatPercent: 64 }, false)).toBe('64%');
    expect(solversBeatenLabel({ available: true, beatPercent: 0 }, true)).toBe('0%');
  });

  it('shows "First!" when this player is the only solver (beatPercent null)', () => {
    expect(solversBeatenLabel({ available: true, beatPercent: null }, true)).toBe('First!');
    expect(solversBeatenLabel({ available: true }, false)).toBe('First!');
  });

  it('falls back to "-" once the final attempt settled without a usable summary', () => {
    expect(solversBeatenLabel(null, true)).toBe('-');
    expect(solversBeatenLabel({ available: false }, true)).toBe('-');
  });
});

describe('isDailyPersonalBest', () => {
  it('is true only for an available summary flagged as a personal best', () => {
    expect(isDailyPersonalBest({ available: true, isPersonalBest: true })).toBe(true);
    expect(isDailyPersonalBest({ available: true, isPersonalBest: false })).toBe(false);
    expect(isDailyPersonalBest({ available: true })).toBe(false);
    expect(isDailyPersonalBest({ available: false, isPersonalBest: true })).toBe(false);
    expect(isDailyPersonalBest(null)).toBe(false);
  });
});
