import { describe, it, expect } from 'vitest';
import { freshBunch, drawTile, drawTiles, returnTile, countTiles, TOTAL_TILES } from '../src/index.js';

describe('bunch draws', () => {
  it('decrements the drawn letter and total', () => {
    const bunch = freshBunch();
    const before = countTiles(bunch);
    const letter = drawTile(bunch);
    expect(letter).not.toBeNull();
    expect(countTiles(bunch)).toBe(before - 1);
  });

  it('drains the whole bunch to exactly empty and then returns null', () => {
    const bunch = freshBunch();
    const drawn = drawTiles(bunch, TOTAL_TILES);
    expect(drawn).toHaveLength(TOTAL_TILES);
    expect(countTiles(bunch)).toBe(0);
    expect(drawTile(bunch)).toBeNull();
  });

  it('drawTiles stops early when the bunch runs out', () => {
    const bunch = freshBunch();
    const drawn = drawTiles(bunch, TOTAL_TILES + 50);
    expect(drawn).toHaveLength(TOTAL_TILES);
  });

  it('returnTile puts a tile back', () => {
    const bunch = freshBunch();
    drawTile(bunch); // removes one
    const total = countTiles(bunch);
    returnTile(bunch, 'Q');
    expect(countTiles(bunch)).toBe(total + 1);
  });

  it('produces an unbiased distribution over many draws', () => {
    // Draw the full bunch repeatedly; the aggregate letter frequencies should
    // match the distribution exactly (draws are exhaustive, so this is deterministic).
    const tally: Record<string, number> = {};
    const runs = 200;
    for (let i = 0; i < runs; i++) {
      const bunch = freshBunch();
      for (const l of drawTiles(bunch, TOTAL_TILES)) tally[l] = (tally[l] ?? 0) + 1;
    }
    // Every A should have been drawn exactly 13 * runs times across exhaustive draws.
    expect(tally.A).toBe(13 * runs);
    expect(tally.Z).toBe(2 * runs);
    expect(tally.E).toBe(18 * runs);
  });
});
