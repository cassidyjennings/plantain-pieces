import { describe, it, expect } from 'vitest';
import {
  foldDiacritics,
  normalizeWord,
  normalizeWordList,
  splitWordInput,
  validateDictionaryConfig,
  DEFAULT_DICTIONARY_CONFIG,
  type DictionaryConfig,
} from '../src/index.js';

describe('normalizeWord', () => {
  it('uppercases and trims a valid word', () => {
    expect(normalizeWord('  banana  ')).toBe('BANANA');
  });

  it('rejects words shorter than 2 letters', () => {
    expect(normalizeWord('a')).toBeNull();
  });

  it('rejects words longer than 20 letters', () => {
    expect(normalizeWord('a'.repeat(21))).toBeNull();
  });

  it('rejects non-alphabetic characters', () => {
    expect(normalizeWord('can-not')).toBeNull();
    expect(normalizeWord("it's")).toBeNull();
    expect(normalizeWord('123')).toBeNull();
  });

  it('accepts a word at exactly the boundary lengths', () => {
    expect(normalizeWord('ab')).toBe('AB');
    expect(normalizeWord('a'.repeat(20))).toBe('A'.repeat(20));
  });

  it('folds accents onto the base letter instead of rejecting the word', () => {
    expect(normalizeWord('café')).toBe('CAFE');
    expect(normalizeWord('NIÑO')).toBe('NINO');
    expect(normalizeWord('schön')).toBe('SCHON');
  });
});

describe('foldDiacritics', () => {
  it('strips combining accents exposed by NFD decomposition', () => {
    expect(foldDiacritics('ÉLÈVE')).toBe('ELEVE');
    expect(foldDiacritics('Ça')).toBe('Ca');
  });

  it('maps letters that NFD leaves intact', () => {
    // These carry no combining mark to strip, so they need the explicit table.
    expect(foldDiacritics('Łódź')).toBe('Lodz');
    expect(foldDiacritics('groß')).toBe('groSS');
    expect(foldDiacritics('Æon')).toBe('AEon');
    expect(foldDiacritics('Øre')).toBe('Ore');
  });

  it('leaves plain ASCII untouched', () => {
    expect(foldDiacritics('BANANA')).toBe('BANANA');
  });

  it('does not transliterate non-Latin scripts (they get rejected downstream)', () => {
    // A game played with A-Z tiles can't render these, so passing them through unchanged —
    // and letting WORD_PATTERN reject them — is the intended outcome.
    expect(normalizeWord('كتاب')).toBeNull();
  });
});

describe('normalizeWordList', () => {
  it('dedupes case-insensitively and preserves first-seen order', () => {
    const { words } = normalizeWordList(['Banana', 'BANANA', 'banana', 'Comet']);
    expect(words).toEqual(['BANANA', 'COMET']);
  });

  it('separates invalid entries into rejected', () => {
    const { words, rejected } = normalizeWordList(['orbit', 'x', 'toolong'.repeat(5), '  ']);
    expect(words).toEqual(['ORBIT']);
    expect(rejected).toEqual(['x', 'toolong'.repeat(5)]);
  });

  it('ignores blank entries entirely (not counted as rejected)', () => {
    const { rejected } = normalizeWordList(['', '   ', 'ok']);
    expect(rejected).toEqual([]);
  });
});

describe('splitWordInput', () => {
  it('splits on commas, whitespace, and newlines', () => {
    expect(splitWordInput('apple, pear\nbanana   comet,orbit')).toEqual([
      'apple',
      'pear',
      'banana',
      'comet',
      'orbit',
    ]);
  });

  it('returns an empty array for blank input', () => {
    expect(splitWordInput('   \n  ')).toEqual([]);
  });
});

describe('validateDictionaryConfig', () => {
  const owned = ['set-a', 'set-b'];

  it('accepts the default config', () => {
    expect(validateDictionaryConfig(DEFAULT_DICTIONARY_CONFIG, owned)).toEqual({ valid: true });
  });

  it('rejects when both base and custom sets are disabled', () => {
    const config: DictionaryConfig = { ...DEFAULT_DICTIONARY_CONFIG, baseEnabled: false, customSetIds: [] };
    expect(validateDictionaryConfig(config, owned)).toEqual({
      valid: false,
      reason: 'NO_WORD_SOURCE',
    });
  });

  it('accepts base disabled if at least one custom set is enabled', () => {
    const config: DictionaryConfig = { ...DEFAULT_DICTIONARY_CONFIG, baseEnabled: false, customSetIds: ['set-a'] };
    expect(validateDictionaryConfig(config, owned)).toEqual({ valid: true });
  });

  it('rejects a customSetId the caller does not own', () => {
    const config: DictionaryConfig = { ...DEFAULT_DICTIONARY_CONFIG, customSetIds: ['not-mine'] };
    expect(validateDictionaryConfig(config, owned)).toEqual({
      valid: false,
      reason: 'INVALID_CUSTOM_SET',
    });
  });

  it('rejects minLength > maxLength', () => {
    const config: DictionaryConfig = { ...DEFAULT_DICTIONARY_CONFIG, minLength: 8, maxLength: 5 };
    expect(validateDictionaryConfig(config, owned)).toEqual({
      valid: false,
      reason: 'INVALID_DICTIONARY_CONFIG',
    });
  });

  it('rejects minLength out of bounds', () => {
    expect(
      validateDictionaryConfig({ ...DEFAULT_DICTIONARY_CONFIG, minLength: 0 }, owned),
    ).toEqual({ valid: false, reason: 'INVALID_DICTIONARY_CONFIG' });
    expect(
      validateDictionaryConfig({ ...DEFAULT_DICTIONARY_CONFIG, minLength: 25 }, owned),
    ).toEqual({ valid: false, reason: 'INVALID_DICTIONARY_CONFIG' });
  });

  it('rejects maxLength above the sanity ceiling', () => {
    const config: DictionaryConfig = { ...DEFAULT_DICTIONARY_CONFIG, maxLength: 30 };
    expect(validateDictionaryConfig(config, owned)).toEqual({
      valid: false,
      reason: 'INVALID_DICTIONARY_CONFIG',
    });
  });

  it('accepts a null maxLength (no upper bound)', () => {
    const config: DictionaryConfig = { ...DEFAULT_DICTIONARY_CONFIG, maxLength: null };
    expect(validateDictionaryConfig(config, owned)).toEqual({ valid: true });
  });

  it('accepts a custom set as the base when it is also an included set', () => {
    const config: DictionaryConfig = {
      ...DEFAULT_DICTIONARY_CONFIG,
      baseEnabled: false,
      baseSetId: 'set-a',
      customSetIds: ['set-a', 'set-b'],
    };
    expect(validateDictionaryConfig(config, owned)).toEqual({ valid: true });
  });

  it('rejects a base set that is not among the included sets', () => {
    // Otherwise the union that decides validity wouldn't actually contain the base.
    const config: DictionaryConfig = {
      ...DEFAULT_DICTIONARY_CONFIG,
      baseEnabled: false,
      baseSetId: 'set-a',
      customSetIds: ['set-b'],
    };
    expect(validateDictionaryConfig(config, owned)).toEqual({
      valid: false,
      reason: 'INVALID_CUSTOM_SET',
    });
  });

  it('rejects a base set the caller does not own', () => {
    const config: DictionaryConfig = {
      ...DEFAULT_DICTIONARY_CONFIG,
      baseEnabled: false,
      baseSetId: 'not-mine',
      customSetIds: ['not-mine'],
    };
    expect(validateDictionaryConfig(config, owned)).toEqual({
      valid: false,
      reason: 'INVALID_CUSTOM_SET',
    });
  });
});
