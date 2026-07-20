import { describe, it, expect } from 'vitest';
import { validateDisplayName } from '../src/index.js';

describe('validateDisplayName', () => {
  it('accepts a normal name', () => {
    expect(validateDisplayName('Cassidy')).toEqual({ valid: true });
  });

  it('accepts letters, digits, spaces, underscore and hyphen', () => {
    expect(validateDisplayName('Player_1 - two')).toEqual({ valid: true });
  });

  it('accepts non-latin letters', () => {
    expect(validateDisplayName('Ольга')).toEqual({ valid: true });
    expect(validateDisplayName('さくら')).toEqual({ valid: true });
  });

  it('rejects empty / whitespace-only', () => {
    expect(validateDisplayName('')).toEqual({ valid: false, reason: 'EMPTY' });
    expect(validateDisplayName('   ')).toEqual({ valid: false, reason: 'EMPTY' });
  });

  it('rejects names longer than 20 chars', () => {
    expect(validateDisplayName('a'.repeat(21))).toEqual({ valid: false, reason: 'TOO_LONG' });
  });

  it('accepts a name at exactly 20 chars', () => {
    expect(validateDisplayName('a'.repeat(20))).toEqual({ valid: true });
  });

  it('rejects disallowed characters', () => {
    expect(validateDisplayName('bad<name>')).toEqual({ valid: false, reason: 'INVALID_CHARS' });
    expect(validateDisplayName('emoji😀here')).toEqual({ valid: false, reason: 'INVALID_CHARS' });
    expect(validateDisplayName('semi;colon')).toEqual({ valid: false, reason: 'INVALID_CHARS' });
  });

  it('trims surrounding whitespace before validating', () => {
    expect(validateDisplayName('  Ok  ')).toEqual({ valid: true });
  });
});
