import { describe, it, expect } from 'vitest';
import {
  validateAvatarConfig,
  normalizeAvatarConfig,
  DEFAULT_AVATAR_CONFIG,
} from '../src/index.js';

describe('validateAvatarConfig', () => {
  it('accepts the default config', () => {
    expect(validateAvatarConfig(DEFAULT_AVATAR_CONFIG)).toEqual({ valid: true });
  });

  it('accepts a valid config with accessories', () => {
    expect(validateAvatarConfig({ base: 'golden', hat: 'crown', glasses: 'shades', hair: 'curls' })).toEqual({
      valid: true,
    });
  });

  it('requires a known base', () => {
    expect(validateAvatarConfig({ base: 'neon' }).valid).toBe(false);
    expect(validateAvatarConfig({}).valid).toBe(false);
  });

  it('rejects an unknown accessory option', () => {
    expect(validateAvatarConfig({ base: 'ripe', hat: 'sombrero' }).valid).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(validateAvatarConfig(null).valid).toBe(false);
    expect(validateAvatarConfig('ripe').valid).toBe(false);
  });
});

describe('normalizeAvatarConfig', () => {
  it('fills defaults for empty / legacy jsonb', () => {
    expect(normalizeAvatarConfig({})).toEqual({ base: 'ripe', hat: 'none', glasses: 'none', hair: 'none' });
    expect(normalizeAvatarConfig(null)).toEqual({ base: 'ripe', hat: 'none', glasses: 'none', hair: 'none' });
  });

  it('drops invalid slot values back to defaults but keeps valid ones', () => {
    expect(normalizeAvatarConfig({ base: 'green', hat: 'bogus', glasses: 'star' })).toEqual({
      base: 'green',
      hat: 'none',
      glasses: 'star',
      hair: 'none',
    });
  });
});
