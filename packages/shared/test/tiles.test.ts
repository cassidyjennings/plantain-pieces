import { describe, it, expect } from 'vitest';
import { TILE_DISTRIBUTION, TOTAL_TILES, initialDealCount, countTiles, freshBunch } from '../src/index.js';

describe('tile distribution', () => {
  it('sums to the standard 144 tiles', () => {
    expect(TOTAL_TILES).toBe(144);
    expect(countTiles(TILE_DISTRIBUTION)).toBe(144);
  });

  it('has all 26 letters', () => {
    expect(Object.keys(TILE_DISTRIBUTION)).toHaveLength(26);
  });

  it('freshBunch is an independent copy', () => {
    const b = freshBunch();
    b.A = 0;
    expect(TILE_DISTRIBUTION.A).toBe(13);
  });
});

describe('initialDealCount', () => {
  it('matches Bananagrams rules by player count', () => {
    expect(initialDealCount(2)).toBe(21);
    expect(initialDealCount(4)).toBe(21);
    expect(initialDealCount(5)).toBe(15);
    expect(initialDealCount(6)).toBe(15);
    expect(initialDealCount(7)).toBe(11);
    expect(initialDealCount(8)).toBe(11);
  });
});
