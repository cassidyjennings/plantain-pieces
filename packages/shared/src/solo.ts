/** Solo mode: a single player clears a Bunch alone, choosing its size and whether elapsed time
 * is tracked (Timed) or not (Zen). Dictionary choice reuses the existing DictionaryConfig
 * unchanged. The initial deal stays fixed (initialDealCount(1) === 21) regardless of bunchSize —
 * a smaller Bunch just means a shorter game, not a smaller opening hand. */

export interface SoloModeConfig {
  bunchSize: number;
  timed: boolean;
  /** Tiles drawn per Peel (1-7). Optional so rooms created before solo peel batches existed —
   * whose mode_config has no such key — still type-check, and so the Results rematch (which
   * passes an old room's mode_config straight back) keeps working. Absent means 1. */
  peelBatch?: number;
}

/** Below this there isn't a meaningful stretch of Peels left after the fixed 21-tile opening
 * deal. Above TOTAL_TILES (144) there are more tiles than the official set provides. */
export const MIN_BUNCH_SIZE = 40;
export const MAX_BUNCH_SIZE = 144;

/** Bounds for the solo "Tiles per peel" slider. The SQL twin is the least(7, greatest(1, ...))
 * clamp in create_solo_room and peel (migration 20261006000003) — keep them in sync. */
export const MIN_PEEL_BATCH = 1;
export const MAX_PEEL_BATCH = 7;

export interface BunchSizePreset {
  label: string;
  size: number;
  /** The "Tiles per peel" slider's starting value when this preset is picked. */
  defaultPeelBatch: number;
}

/** Quick/Standard/Full presets shown as buttons in the solo setup UI. Full uses the entire
 * official 144-tile set (scaledBunchDistribution(144) reproduces it exactly). A bigger Bunch
 * defaults to a bigger peel batch so a Full game doesn't take three times as many Peels. */
export const BUNCH_SIZE_PRESETS: BunchSizePreset[] = [
  { label: 'Quick', size: 54, defaultPeelBatch: 2 },
  { label: 'Standard', size: 99, defaultPeelBatch: 3 },
  { label: 'Full', size: 144, defaultPeelBatch: 5 },
];

/** Same rule as the SQL clamp: anything that isn't a finite number becomes 1 (the pre-batch
 * behaviour), fractions truncate, and the result is pinned to MIN_PEEL_BATCH..MAX_PEEL_BATCH. */
export function clampPeelBatch(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MIN_PEEL_BATCH;
  return Math.min(MAX_PEEL_BATCH, Math.max(MIN_PEEL_BATCH, Math.trunc(value)));
}

/** The slider default for a Bunch size: the matching preset's default, or 1 for a size no
 * preset uses (e.g. a stale value in localStorage from before the presets changed). */
export function defaultPeelBatchForBunchSize(bunchSize: number): number {
  return BUNCH_SIZE_PRESETS.find((p) => p.size === bunchSize)?.defaultPeelBatch ?? MIN_PEEL_BATCH;
}

/** How many tiles must be left in the Bunch for a Peel (rather than Plantains) to be possible.
 * Multiplayer-style modes deal 1 to every active player, so they need one per player. Solo
 * draws min(peelBatch, bunch), so a single remaining tile is still a legal (final) Peel.
 * Mirrors the gate at the top of the peel RPC. */
export function peelThreshold(mode: string | undefined, activePlayers: number): number {
  return mode === 'solo' ? 1 : activePlayers;
}

export type SoloModeConfigValidity =
  | { valid: true }
  | { valid: false; reason: 'INVALID_BUNCH_SIZE' | 'INVALID_TIMED_FLAG' | 'INVALID_PEEL_BATCH' };

/** Validates a candidate SoloModeConfig. Reused by the client (instant feedback) and the Worker
 * (defense-in-depth before calling create_solo_room, which re-validates authoritatively). */
export function validateSoloModeConfig(config: unknown): SoloModeConfigValidity {
  if (typeof config !== 'object' || config === null) {
    return { valid: false, reason: 'INVALID_BUNCH_SIZE' };
  }
  const c = config as Record<string, unknown>;
  const { bunchSize, timed, peelBatch } = c;
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
  if (
    peelBatch !== undefined &&
    (typeof peelBatch !== 'number' ||
      !Number.isInteger(peelBatch) ||
      peelBatch < MIN_PEEL_BATCH ||
      peelBatch > MAX_PEEL_BATCH)
  ) {
    return { valid: false, reason: 'INVALID_PEEL_BATCH' };
  }
  return { valid: true };
}
