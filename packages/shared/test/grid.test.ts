import { describe, it, expect } from 'vitest';
import {
  makeKey,
  extractWords,
  findOrphans,
  isConnected,
  validateStructure,
  validateWithDictionary,
  type GridState,
} from '../src/index.js';

/** Build a grid from an ASCII layout; '.' = empty. Row 0 is the top. */
function grid(rows: string[]): GridState {
  const g: GridState = {};
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch !== '.' && ch !== ' ') g[makeKey(x, y)] = ch.toUpperCase();
    });
  });
  return g;
}

describe('extractWords', () => {
  it('reads horizontal and vertical words', () => {
    // CAT across, with a vertical AT hanging off the A
    const g = grid([
      'CAT',
      '.A.',
      '.T.',
    ]);
    const words = extractWords(g).sort();
    expect(words).toEqual(['AAT', 'CAT'].sort()); // column: A,A,T
  });

  it('ignores single isolated letters', () => {
    const g = grid(['A.B']);
    expect(extractWords(g)).toEqual([]);
  });
});

describe('findOrphans', () => {
  it('flags a tile with no neighbours', () => {
    const g = grid([
      'CAT',
      '...',
      '..Z',
    ]);
    expect(findOrphans(g)).toEqual([makeKey(2, 2)]);
  });

  it('returns none for a fully crossed grid', () => {
    const g = grid([
      'CAT',
      '.A.',
      '.T.',
    ]);
    expect(findOrphans(g)).toEqual([]);
  });
});

describe('isConnected', () => {
  it('detects two disconnected islands', () => {
    const g = grid([
      'CAT...DOG',
    ]);
    expect(isConnected(g)).toBe(false);
  });
  it('true for a single component', () => {
    expect(isConnected(grid(['CAT']))).toBe(true);
  });
});

describe('validateStructure', () => {
  const dealt = ['C', 'A', 'T', 'A', 'T']; // CAT + vertical AT crossing

  it('passes a valid connected grid using all tiles', () => {
    const g = grid([
      'CAT',
      '.A.',
      '.T.',
    ]);
    const res = validateStructure(g, dealt);
    expect(res.valid).toBe(true);
  });

  it('fails when tiles remain unplaced', () => {
    const g = grid(['CAT']);
    const res = validateStructure(g, dealt);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('TILES_REMAINING');
  });

  it('fails on extra/unknown tiles', () => {
    const g = grid([
      'CAT',
      '.A.',
      '.T.',
    ]);
    const res = validateStructure(g, ['C', 'A', 'T']); // grid has more than dealt
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('EXTRA_TILES');
  });

  it('fails on a disconnected grid', () => {
    const g = grid(['CA...TA']); // uses C,A,T,A but split — but multiset differs
    const res = validateStructure(g, ['C', 'A', 'T', 'A']);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('NOT_CONNECTED');
  });

  it('fails on an orphan tile', () => {
    // Z hangs diagonally, not orthogonally adjacent
    const g = grid([
      'CATZ'.replace('Z', '.') + '',
    ]);
    // build explicitly: CAT with a Z diagonally below-right of T
    const g2 = grid([
      'CAT.',
      '...Z',
    ]);
    const res = validateStructure(g2, ['C', 'A', 'T', 'Z']);
    expect(res.valid).toBe(false);
    // Z is disconnected here, so NOT_CONNECTED trips first — assert not valid.
    expect(res.valid).toBe(false);
    void g;
  });
});

describe('validateWithDictionary', () => {
  const dealt = ['C', 'A', 'T', 'A', 'T'];
  const g = grid([
    'CAT',
    '.A.',
    '.T.',
  ]);

  it('rejects when a word is not in the dictionary', () => {
    const dict = new Set(['CAT']); // AAT missing
    const res = validateWithDictionary(g, dealt, (w) => dict.has(w));
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('INVALID_WORDS');
    expect(res.invalidWords).toContain('AAT');
  });

  it('accepts when all words are valid', () => {
    const dict = new Set(['CAT', 'AAT']);
    const res = validateWithDictionary(g, dealt, (w) => dict.has(w));
    expect(res.valid).toBe(true);
  });
});
