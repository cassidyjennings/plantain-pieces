/** Plantain avatar customization. Deliberately extensible: accessory slots and their
 * option lists live in ACCESSORY_SETS, so adding a hat is a one-line data change and both
 * the renderer (<Avatar>) and validation pick it up automatically. */

export interface AvatarConfig {
  /** Ripeness/skin tone of the plantain body. */
  base: string;
  hat?: string;
  glasses?: string;
  hair?: string;
}

/** Every customizable slot and its allowed option ids. `'none'` is always valid for the
 * optional accessory slots; `base` is required and defaults to 'ripe'. Keep ids stable —
 * they're persisted in profiles.avatar_config. */
export const ACCESSORY_SETS = {
  base: ['ripe', 'green', 'golden', 'speckled'],
  hat: ['none', 'straw', 'party', 'crown', 'beanie'],
  glasses: ['none', 'round', 'shades', 'star'],
  hair: ['none', 'swoop', 'curls', 'mohawk'],
} as const;

export type AccessorySlot = keyof typeof ACCESSORY_SETS;

export const DEFAULT_AVATAR_CONFIG: AvatarConfig = {
  base: 'ripe',
  hat: 'none',
  glasses: 'none',
  hair: 'none',
};

export type AvatarConfigValidity =
  | { valid: true }
  | { valid: false; reason: 'INVALID_AVATAR_CONFIG' };

function isAllowed(slot: AccessorySlot, value: unknown): boolean {
  return typeof value === 'string' && (ACCESSORY_SETS[slot] as readonly string[]).includes(value);
}

/** Structural validity: base must be a known tone, and any present accessory must be a
 * known option for its slot. Missing optional slots are treated as 'none'. Mirrors the
 * defensive check the Worker runs before persisting. */
export function validateAvatarConfig(config: unknown): AvatarConfigValidity {
  if (typeof config !== 'object' || config === null) {
    return { valid: false, reason: 'INVALID_AVATAR_CONFIG' };
  }
  const c = config as Record<string, unknown>;
  if (!isAllowed('base', c.base)) return { valid: false, reason: 'INVALID_AVATAR_CONFIG' };
  for (const slot of ['hat', 'glasses', 'hair'] as const) {
    if (c[slot] !== undefined && !isAllowed(slot, c[slot])) {
      return { valid: false, reason: 'INVALID_AVATAR_CONFIG' };
    }
  }
  return { valid: true };
}

/** Normalizes an arbitrary stored value into a complete, valid AvatarConfig, filling any
 * missing/invalid slot with its default. Safe to call on legacy/empty jsonb. */
export function normalizeAvatarConfig(config: unknown): AvatarConfig {
  const c = (typeof config === 'object' && config !== null ? config : {}) as Record<string, unknown>;
  return {
    base: isAllowed('base', c.base) ? (c.base as string) : DEFAULT_AVATAR_CONFIG.base,
    hat: isAllowed('hat', c.hat) ? (c.hat as string) : 'none',
    glasses: isAllowed('glasses', c.glasses) ? (c.glasses as string) : 'none',
    hair: isAllowed('hair', c.hair) ? (c.hair as string) : 'none',
  };
}
