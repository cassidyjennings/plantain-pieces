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
  MIN_PEEL_BATCH,
  MAX_PEEL_BATCH,
  clampPeelBatch,
  defaultPeelBatchForBunchSize,
  peelThreshold,
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

describe('peel batch defaults', () => {
  it('pins the per-preset defaults: Quick 2, Standard 3, Full 5', () => {
    const byLabel = Object.fromEntries(BUNCH_SIZE_PRESETS.map((p) => [p.label, p.defaultPeelBatch]));
    expect(byLabel).toEqual({ Quick: 2, Standard: 3, Full: 5 });
  });

  it('every preset default sits inside the 1-7 range', () => {
    expect(MIN_PEEL_BATCH).toBe(1);
    expect(MAX_PEEL_BATCH).toBe(7);
    for (const p of BUNCH_SIZE_PRESETS) {
      expect(p.defaultPeelBatch).toBeGreaterThanOrEqual(MIN_PEEL_BATCH);
      expect(p.defaultPeelBatch).toBeLessThanOrEqual(MAX_PEEL_BATCH);
    }
  });

  it('defaultPeelBatchForBunchSize returns the matching preset default', () => {
    for (const p of BUNCH_SIZE_PRESETS) {
      expect(defaultPeelBatchForBunchSize(p.size)).toBe(p.defaultPeelBatch);
    }
  });

  it('defaultPeelBatchForBunchSize falls back to 1 for a size no preset uses', () => {
    expect(defaultPeelBatchForBunchSize(77)).toBe(1);
  });
});

describe('clampPeelBatch (mirrors create_solo_room / peel SQL clamp)', () => {
  it('passes integers in range through unchanged', () => {
    for (let n = 1; n <= 7; n++) expect(clampPeelBatch(n)).toBe(n);
  });

  it('clamps out-of-range integers to the nearest bound', () => {
    expect(clampPeelBatch(0)).toBe(1);
    expect(clampPeelBatch(-5)).toBe(1);
    expect(clampPeelBatch(8)).toBe(7);
    expect(clampPeelBatch(99)).toBe(7);
  });

  it('truncates fractions before clamping', () => {
    expect(clampPeelBatch(3.9)).toBe(3);
  });

  it('treats missing or non-numeric input as 1 (old rooms keep old behaviour)', () => {
    expect(clampPeelBatch(undefined)).toBe(1);
    expect(clampPeelBatch(null)).toBe(1);
    expect(clampPeelBatch('4')).toBe(1);
    expect(clampPeelBatch(Number.NaN)).toBe(1);
  });
});

describe('peelThreshold', () => {
  it('solo only needs 1 tile in the Bunch, whatever the active count', () => {
    expect(peelThreshold('solo', 1)).toBe(1);
    expect(peelThreshold('solo', 3)).toBe(1);
  });

  it('every other mode needs one tile per active player', () => {
    expect(peelThreshold('multiplayer', 4)).toBe(4);
    expect(peelThreshold('daily', 1)).toBe(1);
    expect(peelThreshold('xtina', 2)).toBe(2);
    expect(peelThreshold(undefined, 2)).toBe(2);
  });
});

describe('validateSoloModeConfig peelBatch', () => {
  it('accepts a config with no peelBatch (old clients, Results rematch of an old room)', () => {
    expect(validateSoloModeConfig({ bunchSize: 54, timed: false })).toEqual({ valid: true });
  });

  it('accepts every integer from 1 to 7', () => {
    for (let n = 1; n <= 7; n++) {
      expect(validateSoloModeConfig({ bunchSize: 54, timed: false, peelBatch: n })).toEqual({ valid: true });
    }
  });

  it('rejects out-of-range, fractional and non-numeric peelBatch', () => {
    for (const bad of [0, 8, -1, 2.5, '3', null]) {
      expect(validateSoloModeConfig({ bunchSize: 54, timed: false, peelBatch: bad })).toEqual({
        valid: false,
        reason: 'INVALID_PEEL_BATCH',
      });
    }
  });
});
