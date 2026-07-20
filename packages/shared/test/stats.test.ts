import { describe, it, expect } from 'vitest';
import {
  wordRarity,
  WORD_NERD_THRESHOLD,
  computeMoveStats,
  validateGameSummary,
  IDLE_MOVE_THRESHOLD,
  type GameSummary,
} from '../src/index.js';

describe('wordRarity', () => {
  it('scores common short words low', () => {
    // C6 + A1 + T2 = 9
    expect(wordRarity('CAT')).toBe(9);
  });

  it('scores rare-letter words high', () => {
    // Q9 + U3 + I2 + Z9 = 23
    expect(wordRarity('QUIZ')).toBe(23);
    // J9 + A1 + Z9 + Z9 = 28
    expect(wordRarity('JAZZ')).toBe(28);
  });

  it('is case-insensitive', () => {
    expect(wordRarity('quiz')).toBe(wordRarity('QUIZ'));
  });

  it('rare rich words clear the Word Nerd threshold; plain words do not', () => {
    expect(wordRarity('JUKEBOX')).toBeGreaterThanOrEqual(WORD_NERD_THRESHOLD);
    expect(wordRarity('CAT')).toBeLessThan(WORD_NERD_THRESHOLD);
  });
});

describe('computeMoveStats', () => {
  it('returns nulls when nothing was placed', () => {
    expect(computeMoveStats({ tiles: [{ drawnAtMove: 0, placedAtMove: null }], dumps: [] })).toEqual({
      peelEfficiency: null,
      idleTileRatio: null,
      dumpRegret: 0,
    });
  });

  it('averages the wait between draw and placement', () => {
    const stats = computeMoveStats({
      tiles: [
        { drawnAtMove: 0, placedAtMove: 2 }, // wait 2
        { drawnAtMove: 1, placedAtMove: 5 }, // wait 4
      ],
      dumps: [],
    });
    expect(stats.peelEfficiency).toBe(3);
  });

  it('flags idle tiles past the threshold and counts regretful dumps', () => {
    const stats = computeMoveStats({
      tiles: [
        { drawnAtMove: 0, placedAtMove: IDLE_MOVE_THRESHOLD }, // idle
        { drawnAtMove: 0, placedAtMove: 1 }, // not idle
      ],
      dumps: [{ regretful: true }, { regretful: false }, { regretful: true }],
    });
    expect(stats.idleTileRatio).toBe(0.5);
    expect(stats.dumpRegret).toBe(2);
  });
});

describe('validateGameSummary', () => {
  const good: GameSummary = {
    words: ['CAT', 'DOG'],
    placedCount: 6,
    moveStats: { peelEfficiency: 2.5, idleTileRatio: 0.2, dumpRegret: 1 },
  };

  it('accepts a well-formed summary', () => {
    expect(validateGameSummary(good)).toEqual({ valid: true });
  });

  it('accepts null move-stat fields', () => {
    expect(
      validateGameSummary({ ...good, moveStats: { peelEfficiency: null, idleTileRatio: null, dumpRegret: 0 } }),
    ).toEqual({ valid: true });
  });

  it('rejects non-object', () => {
    expect(validateGameSummary(null).valid).toBe(false);
    expect(validateGameSummary(42).valid).toBe(false);
  });

  it('rejects invalid words', () => {
    expect(validateGameSummary({ ...good, words: ['CAT', 'a1'] })).toEqual({ valid: false, reason: 'INVALID_WORD' });
  });

  it('rejects placedCount beyond the known final tile count', () => {
    expect(validateGameSummary(good, { finalTileCount: 4 })).toEqual({ valid: false, reason: 'OUT_OF_RANGE' });
    expect(validateGameSummary(good, { finalTileCount: 21 })).toEqual({ valid: true });
  });

  it('rejects an out-of-range idle ratio', () => {
    expect(
      validateGameSummary({ ...good, moveStats: { ...good.moveStats, idleTileRatio: 1.5 } }),
    ).toEqual({ valid: false, reason: 'OUT_OF_RANGE' });
  });

  it('rejects a non-integer dumpRegret', () => {
    expect(
      validateGameSummary({ ...good, moveStats: { ...good.moveStats, dumpRegret: 1.5 } }),
    ).toEqual({ valid: false, reason: 'OUT_OF_RANGE' });
  });
});
