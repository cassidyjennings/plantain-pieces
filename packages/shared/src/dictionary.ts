import type { DictionaryConfig } from './types.js';

/** Bounds shared by both the client (instant feedback) and the Worker (defense-in-depth
 * 400s before calling the RPC). The RPCs re-validate all of this authoritatively — these
 * constants exist so both sides agree on the numbers without duplicating them. */
export const WORD_LENGTH_MIN = 2;
export const WORD_LENGTH_MAX = 20;
export const MAX_WORDS_PER_SET = 2000;
export const MAX_SETS_PER_OWNER = 30;
export const MAX_PRESETS_PER_OWNER = 25;
export const MAX_SET_NAME_LENGTH = 60;
export const MAX_PRESET_NAME_LENGTH = 40;
/** Sanity ceiling for DictionaryConfig.maxLength — not a word-length bound itself. */
export const CONFIG_MAX_LENGTH_CEILING = 24;

export const WORD_PATTERN = /^[A-Z]{2,20}$/;

/** Uppercases + trims a candidate word; returns null if it doesn't match the allowed
 * shape (letters only, 2-20 chars) rather than throwing, so callers can filter a list. */
export function normalizeWord(raw: string): string | null {
  const word = raw.trim().toUpperCase();
  return WORD_PATTERN.test(word) ? word : null;
}

export interface NormalizeWordListResult {
  words: string[];
  rejected: string[];
}

/** Normalizes a raw list of candidate words: uppercases, trims, dedupes, and separates
 * out anything that doesn't fit WORD_PATTERN so the UI can show what got skipped. */
export function normalizeWordList(raw: string[]): NormalizeWordListResult {
  const seen = new Set<string>();
  const words: string[] = [];
  const rejected: string[] = [];
  for (const entry of raw) {
    const normalized = normalizeWord(entry);
    if (normalized === null) {
      if (entry.trim() !== '') rejected.push(entry.trim());
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      words.push(normalized);
    }
  }
  return { words, rejected };
}

/** Splits freeform pasted/typed text into individual word candidates — any of comma,
 * whitespace, or newline separates entries, since users may paste from anywhere. */
export function splitWordInput(raw: string): string[] {
  return raw.split(/[,\s]+/).filter((s) => s.length > 0);
}

export type DictionaryConfigValidity =
  | { valid: true }
  | { valid: false; reason: 'INVALID_DICTIONARY_CONFIG' | 'NO_WORD_SOURCE' | 'INVALID_CUSTOM_SET' };

/** Structural validity check for a DictionaryConfig, mirroring the authoritative check in
 * the `_validate_dictionary_config` SQL function. `ownedCustomSetIds` is the id set the
 * caller is allowed to reference — pass the current user's own custom set ids. */
export function validateDictionaryConfig(
  config: DictionaryConfig,
  ownedCustomSetIds: string[] | Set<string>,
): DictionaryConfigValidity {
  const { minLength, maxLength, baseEnabled, customSetIds } = config;

  if (!Number.isInteger(minLength) || minLength < 1 || minLength > WORD_LENGTH_MAX) {
    return { valid: false, reason: 'INVALID_DICTIONARY_CONFIG' };
  }
  if (maxLength !== null) {
    if (!Number.isInteger(maxLength) || maxLength < minLength || maxLength > CONFIG_MAX_LENGTH_CEILING) {
      return { valid: false, reason: 'INVALID_DICTIONARY_CONFIG' };
    }
  }
  if (!baseEnabled && customSetIds.length === 0) {
    return { valid: false, reason: 'NO_WORD_SOURCE' };
  }

  const owned = ownedCustomSetIds instanceof Set ? ownedCustomSetIds : new Set(ownedCustomSetIds);
  for (const id of customSetIds) {
    if (!owned.has(id)) {
      return { valid: false, reason: 'INVALID_CUSTOM_SET' };
    }
  }

  return { valid: true };
}
