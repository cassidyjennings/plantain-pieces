import { describe, it, expect } from 'vitest';
import {
  EASTER_EGG_WORDS,
  EASTER_EGGS,
  SUPERCALI,
  FREEZE_DURATION_MS,
  isEasterEggWord,
  eggWordsIn,
  newlyFoundEggs,
  isSubMultiset,
  validateSupercaliStructure,
  sanitizeEggsFound,
  makeKey,
  type GridState,
} from '../src/index.js';

/** A horizontal run of `word` starting at (x0, y). */
function row(word: string, x0: number, y: number): GridState {
  const g: GridState = {};
  [...word].forEach((l, i) => {
    g[makeKey(x0 + i, y)] = l;
  });
  return g;
}

describe('egg word list', () => {
  it('is exactly the four spec words, in the order the SQL twin uses', () => {
    expect([...EASTER_EGG_WORDS]).toEqual(['MIT', 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS', 'GHOST', 'FREEZE']);
  });

  it('has metadata for every word', () => {
    for (const w of EASTER_EGG_WORDS) expect(EASTER_EGGS[w].description.length).toBeGreaterThan(0);
    expect(EASTER_EGGS.MIT.effect).toBe('tint');
    expect(EASTER_EGGS[SUPERCALI].effect).toBe('instant_win');
    expect(EASTER_EGGS.GHOST.effect).toBe('ghost');
    expect(EASTER_EGGS.FREEZE.effect).toBe('freeze');
  });

  it('SUPERCALI is 34 letters and fits the 50-wide grid', () => {
    expect(SUPERCALI).toHaveLength(34);
    expect(SUPERCALI.length).toBeLessThan(50);
  });

  it('freezes for exactly 10 seconds (archive_game subtracts the same 10000)', () => {
    expect(FREEZE_DURATION_MS).toBe(10_000);
  });
});

describe('isEasterEggWord / eggWordsIn', () => {
  it('matches uppercase egg words only', () => {
    expect(isEasterEggWord('MIT')).toBe(true);
    expect(isEasterEggWord('GHOST')).toBe(true);
    expect(isEasterEggWord('mit')).toBe(false);
    expect(isEasterEggWord('MITT')).toBe(false);
  });

  it('extracts eggs from a word list in canonical order, deduped', () => {
    expect(eggWordsIn(['CAT', 'FREEZE', 'MIT', 'FREEZE', 'DOG'])).toEqual(['MIT', 'FREEZE']);
    expect(eggWordsIn(['CAT', 'DOG'])).toEqual([]);
  });
});

describe('newlyFoundEggs (trigger-once support)', () => {
  it('returns eggs present but not yet fired', () => {
    expect(newlyFoundEggs(['GHOST', 'MIT', 'CAT'], new Set())).toEqual(['MIT', 'GHOST']);
  });
  it('skips eggs that already fired', () => {
    expect(newlyFoundEggs(['GHOST', 'MIT'], new Set(['MIT']))).toEqual(['GHOST']);
    expect(newlyFoundEggs(['MIT'], new Set(['MIT']))).toEqual([]);
  });
});

describe('isSubMultiset', () => {
  it('accepts equal and smaller multisets', () => {
    expect(isSubMultiset({ A: 1 }, { A: 1 })).toBe(true);
    expect(isSubMultiset({ A: 1 }, { A: 2, B: 1 })).toBe(true);
    expect(isSubMultiset({}, { A: 1 })).toBe(true);
  });
  it('rejects a surplus of any letter, even when another letter is short', () => {
    expect(isSubMultiset({ A: 2 }, { A: 1, B: 5 })).toBe(false);
    expect(isSubMultiset({ Z: 1 }, { A: 1 })).toBe(false);
  });
});

describe('validateSupercaliStructure', () => {
  const wordGrid = row(SUPERCALI, 5, 10);
  const exactRack = [...SUPERCALI];

  it('accepts the word with extra tiles still in hand (sub-multiset, not equality)', () => {
    const r = validateSupercaliStructure(wordGrid, [...exactRack, 'Q', 'I']);
    expect(r.valid).toBe(true);
    expect(r.words).toEqual([SUPERCALI]);
  });

  it('rejects an empty grid', () => {
    expect(validateSupercaliStructure({}, exactRack)).toMatchObject({ valid: false, reason: 'EMPTY_GRID' });
  });

  it('rejects letters the player does not own', () => {
    expect(validateSupercaliStructure(wordGrid, exactRack.slice(1))).toMatchObject({
      valid: false,
      reason: 'EXTRA_TILES',
    });
  });

  it('rejects a disconnected grid', () => {
    const g = { ...wordGrid, ...row('QI', 5, 20) };
    expect(validateSupercaliStructure(g, [...exactRack, 'Q', 'I'])).toMatchObject({
      valid: false,
      reason: 'NOT_CONNECTED',
    });
  });

  it('rejects a single orphan tile', () => {
    expect(validateSupercaliStructure({ [makeKey(1, 1)]: 'S' }, exactRack)).toMatchObject({
      valid: false,
      reason: 'ORPHAN_TILE',
    });
  });

  it('rejects a grid that does not contain the word', () => {
    expect(validateSupercaliStructure(row('QI', 5, 20), ['Q', 'I'])).toMatchObject({
      valid: false,
      reason: 'NO_SUPERCALI',
    });
  });

  it('rejects the word embedded in a longer run', () => {
    const g = { ...wordGrid, [makeKey(39, 10)]: 'I' };
    expect(validateSupercaliStructure(g, [...exactRack, 'I'])).toMatchObject({
      valid: false,
      reason: 'NO_SUPERCALI',
    });
  });
});

describe('sanitizeEggsFound', () => {
  it('uppercases and dedupes a valid list into canonical order', () => {
    expect(sanitizeEggsFound(['ghost', 'MIT', 'GHOST'])).toEqual(['MIT', 'GHOST']);
    expect(sanitizeEggsFound([])).toEqual([]);
  });
  it('returns null for a non-array, a non-string, a non-egg, or an absurd length', () => {
    expect(sanitizeEggsFound('MIT')).toBeNull();
    expect(sanitizeEggsFound([42])).toBeNull();
    expect(sanitizeEggsFound(['MIT', 'NOTANEGG'])).toBeNull();
    expect(sanitizeEggsFound(new Array(50).fill('MIT'))).toBeNull();
  });
});
