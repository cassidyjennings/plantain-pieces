import { describe, it, expect } from 'vitest';
import {
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
});
