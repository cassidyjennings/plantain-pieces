/** Solo mode: a single player clears a Bunch alone, choosing its size and whether elapsed time
 * is tracked (Timed) or not (Zen). Dictionary choice reuses the existing DictionaryConfig
 * unchanged. The initial deal stays fixed (initialDealCount(1) === 21) regardless of bunchSize —
 * a smaller Bunch just means a shorter game, not a smaller opening hand. */

export interface SoloModeConfig {
  bunchSize: number;
  timed: boolean;
}

/** Below this there isn't a meaningful stretch of Peels left after the fixed 21-tile opening
 * deal. Above TOTAL_TILES (144) there are more tiles than the official set provides. */
export const MIN_BUNCH_SIZE = 40;
export const MAX_BUNCH_SIZE = 144;

export interface BunchSizePreset {
  label: string;
  size: number;
}

/** Quick/Standard/Full presets shown as buttons in the solo setup UI. Full uses the entire
 * official 144-tile set (scaledBunchDistribution(144) reproduces it exactly). */
export const BUNCH_SIZE_PRESETS: BunchSizePreset[] = [
  { label: 'Quick', size: 54 },
  { label: 'Standard', size: 99 },
  { label: 'Full', size: 144 },
];

export type SoloModeConfigValidity =
  | { valid: true }
  | { valid: false; reason: 'INVALID_BUNCH_SIZE' | 'INVALID_TIMED_FLAG' };

/** Validates a candidate SoloModeConfig. Reused by the client (instant feedback) and the Worker
 * (defense-in-depth before calling create_solo_room, which re-validates authoritatively). */
export function validateSoloModeConfig(config: unknown): SoloModeConfigValidity {
  if (typeof config !== 'object' || config === null) {
    return { valid: false, reason: 'INVALID_BUNCH_SIZE' };
  }
  const c = config as Record<string, unknown>;
  const { bunchSize, timed } = c;
  if (
    typeof bunchSize !== 'number' ||
    !Number.isInteger(bunchSize) ||
    bunchSize < MIN_BUNCH_SIZE ||
    bunchSize > MAX_BUNCH_SIZE
  ) {
    return { valid: false, reason: 'INVALID_BUNCH_SIZE' };
  }
  if (typeof timed !== 'boolean') {
    return { valid: false, reason: 'INVALID_TIMED_FLAG' };
  }
  return { valid: true };
}
