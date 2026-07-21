import { describe, it, expect } from 'vitest';
import {
  scaledBunchDistribution,
  countTiles,
  TILE_DISTRIBUTION,
  TOTAL_TILES,
  validateSoloModeConfig,
  MIN_BUNCH_SIZE,
  MAX_BUNCH_SIZE,
  BUNCH_SIZE_PRESETS,
} from '../src/index.js';

describe('scaledBunchDistribution', () => {
  it('reproduces TILE_DISTRIBUTION exactly at the full 144 size', () => {
    expect(scaledBunchDistribution(TOTAL_TILES)).toEqual(TILE_DISTRIBUTION);
  });

  it('sums to exactly the requested bunch size for various sizes', () => {
    for (const size of [1, 26, 40, 54, 99, 100, 143, 144]) {
      expect(countTiles(scaledBunchDistribution(size))).toBe(size);
    }
  });

  it('guarantees every letter has at least 1 tile once the bunch fits the alphabet', () => {
    for (const size of [26, 40, 54, 60, 99]) {
      const dist = scaledBunchDistribution(size);
      for (const letter of Object.keys(TILE_DISTRIBUTION)) {
        expect(dist[letter]).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('never produces a negative count', () => {
    for (const size of [0, 1, 10, 26, 40, 144]) {
      const dist = scaledBunchDistribution(size);
      for (const n of Object.values(dist)) expect(n).toBeGreaterThanOrEqual(0);
    }
  });

  it('gives more tiles to common letters than rare ones at a mid-size bunch', () => {
    const dist = scaledBunchDistribution(96);
    expect(dist.E).toBeGreaterThan(dist.Z);
    expect(dist.A).toBeGreaterThan(dist.Q);
  });

  it('throws on a non-integer or negative bunch size', () => {
    expect(() => scaledBunchDistribution(-1)).toThrow();
    expect(() => scaledBunchDistribution(1.5)).toThrow();
  });

  it('below 26 tiles, some letters may legitimately be zero (not enough tiles for the alphabet)', () => {
    const dist = scaledBunchDistribution(10);
    expect(countTiles(dist)).toBe(10);
    // Just confirm it doesn't throw and totals correctly; zero-letters are expected here.
  });
});

describe('validateSoloModeConfig', () => {
  it('accepts a valid config at each preset', () => {
    for (const preset of BUNCH_SIZE_PRESETS) {
      expect(validateSoloModeConfig({ bunchSize: preset.size, timed: true })).toEqual({ valid: true });
      expect(validateSoloModeConfig({ bunchSize: preset.size, timed: false })).toEqual({ valid: true });
    }
  });

  it('rejects a bunch size below the minimum', () => {
    expect(validateSoloModeConfig({ bunchSize: MIN_BUNCH_SIZE - 1, timed: true })).toEqual({
      valid: false,
      reason: 'INVALID_BUNCH_SIZE',
    });
  });

  it('rejects a bunch size above the maximum', () => {
    expect(validateSoloModeConfig({ bunchSize: MAX_BUNCH_SIZE + 1, timed: true })).toEqual({
      valid: false,
      reason: 'INVALID_BUNCH_SIZE',
    });
  });

  it('accepts the exact boundary sizes', () => {
    expect(validateSoloModeConfig({ bunchSize: MIN_BUNCH_SIZE, timed: true })).toEqual({ valid: true });
    expect(validateSoloModeConfig({ bunchSize: MAX_BUNCH_SIZE, timed: true })).toEqual({ valid: true });
  });

  it('rejects a non-integer bunch size', () => {
    expect(validateSoloModeConfig({ bunchSize: 50.5, timed: true }).valid).toBe(false);
  });

  it('rejects a non-boolean timed flag', () => {
    expect(validateSoloModeConfig({ bunchSize: 60, timed: 'yes' as unknown as boolean })).toEqual({
      valid: false,
      reason: 'INVALID_TIMED_FLAG',
    });
  });

  it('rejects non-objects', () => {
    expect(validateSoloModeConfig(null).valid).toBe(false);
    expect(validateSoloModeConfig(42).valid).toBe(false);
  });
});
