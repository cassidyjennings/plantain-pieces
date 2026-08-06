import { describe, it, expect } from 'vitest';
import {
  extractWords,
  isConnected,
  findOrphans,
  XTINA_WORDS,
  XTINA_STEPS,
  XTINA_BUNCH_SIZE,
  XTINA_OWNER_TILES,
  XTINA_OWNER_DEAL,
  xtinaTarget,
  xtinaHintCells,
  xtinaStepLetters,
  xtinaAccentCells,
  xtinaGridMatches,
  xtinaBunch,
} from '../src/index.js';

const EXPECTED_WORDS = [
  'YOURE', 'BEAUTIFUL', 'INTELLIGENT', 'CARING', 'STRONG',
  'HILARIOUS', 'SPECIAL', 'DRIVEN', 'MY', 'LOVE',
];

describe('xtina board spec', () => {
  it('deals the ten words in the required order', () => {
    expect(XTINA_WORDS.map((w) => w.word)).toEqual(EXPECTED_WORDS);
    expect(XTINA_STEPS).toBe(10);
    // YOURE first, MY second-to-last, LOVE last.
    expect(XTINA_WORDS[0].word).toBe('YOURE');
    expect(XTINA_WORDS[XTINA_STEPS - 2].word).toBe('MY');
    expect(XTINA_WORDS[XTINA_STEPS - 1].word).toBe('LOVE');
  });

  it('anchors YOURE at (18,22)', () => {
    expect(xtinaTarget(1)).toEqual({
      '18,22': 'Y', '19,22': 'O', '20,22': 'U', '21,22': 'R', '22,22': 'E',
    });
  });

  it('places 56 cells in total', () => {
    expect(Object.keys(xtinaTarget(XTINA_STEPS))).toHaveLength(56);
  });

  it('stays connected and orphan-free at every step', () => {
    for (let step = 1; step <= XTINA_STEPS; step++) {
      const grid = xtinaTarget(step);
      expect(isConnected(grid), `step ${step} connected`).toBe(true);
      expect(findOrphans(grid), `step ${step} orphans`).toEqual([]);
    }
  });

  it('extracts to exactly the ten intended words and no accidental ones', () => {
    const found = extractWords(xtinaTarget(XTINA_STEPS)).sort();
    expect(found).toEqual([...EXPECTED_WORDS].sort());
  });

  it('deals the documented number of new tiles per step', () => {
    const counts = Array.from({ length: XTINA_STEPS }, (_, i) => xtinaStepLetters(i + 1).length);
    expect(counts).toEqual([5, 8, 10, 5, 5, 8, 6, 5, 1, 3]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(56);
  });

  it('deals exactly the letters of the cells it hints', () => {
    for (let step = 1; step <= XTINA_STEPS; step++) {
      expect(xtinaStepLetters(step)).toHaveLength(xtinaHintCells(step).size);
    }
  });

  it('never hints a cell that is already occupied', () => {
    for (let step = 2; step <= XTINA_STEPS; step++) {
      const occupied = new Set(Object.keys(xtinaTarget(step - 1)));
      for (const key of xtinaHintCells(step)) {
        expect(occupied.has(key), `step ${step} hints occupied ${key}`).toBe(false);
      }
    }
  });

  it('accents exactly the cells of YOURE, MY and LOVE', () => {
    const accent = xtinaAccentCells();
    // YOURE (5) + MY (2) + LOVE (4) = 11 cells, minus the one Y that YOURE and MY SHARE WITH
    // EACH OTHER = 10 distinct. LOVE's L is shared with BEAUTIFUL, which is not an accent word,
    // so it does not collapse anything here.
    expect(accent.size).toBe(10);
    expect(accent.has('18,22')).toBe(true); // shared Y of YOURE/MY
    expect(accent.has('18,21')).toBe(true); // M of MY
    expect(accent.has('20,27')).toBe(true); // shared L of BEAUTIFUL/LOVE
    expect(accent.has('20,19')).toBe(false); // B of BEAUTIFUL is not accented
  });

  it('sizes the bunch so it lands on exactly zero', () => {
    const bunch = xtinaBunch();
    const total = Object.values(bunch).reduce((a, b) => a + b, 0);
    expect(total).toBe(XTINA_BUNCH_SIZE);
    expect(total).toBe(70);

    let remaining = total;
    remaining -= xtinaStepLetters(1).length + XTINA_OWNER_DEAL; // Split
    expect(remaining).toBe(60);
    for (let step = 2; step <= XTINA_STEPS; step++) {
      // Every peel must be legal: two active players need two tiles available.
      expect(remaining, `bunch before peel to step ${step}`).toBeGreaterThanOrEqual(2);
      remaining -= xtinaStepLetters(step).length + 1;
    }
    expect(remaining).toBe(0);
  });

  it('gives the owner 14 junk tiles, all X or Z', () => {
    expect(XTINA_OWNER_TILES).toHaveLength(XTINA_OWNER_DEAL + (XTINA_STEPS - 1));
    expect(XTINA_OWNER_TILES).toHaveLength(14);
    expect(new Set(XTINA_OWNER_TILES)).toEqual(new Set(['X', 'Z']));
  });

  it('matches a grid only when it equals the cumulative target exactly', () => {
    expect(xtinaGridMatches(xtinaTarget(2), 2)).toBe(true);
    expect(xtinaGridMatches(xtinaTarget(1), 2)).toBe(false);
    expect(xtinaGridMatches(xtinaTarget(3), 2)).toBe(false);
    // Right letters, wrong place: shift YOURE one cell right.
    const shifted = { '19,22': 'Y', '20,22': 'O', '21,22': 'U', '22,22': 'R', '23,22': 'E' };
    expect(xtinaGridMatches(shifted, 1)).toBe(false);
  });
});
