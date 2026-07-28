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

/** Letters that survive NFD decomposition intact (their accent isn't a combining mark, it's
 * baked into the glyph or the letter is a genuine ligature), so they need an explicit mapping. */
const UNDECOMPOSABLE: Record<string, string> = {
  Ł: 'L',
  Ø: 'O',
  Đ: 'D',
  Ð: 'D',
  Þ: 'TH',
  Æ: 'AE',
  Œ: 'OE',
  ß: 'SS',
  ẞ: 'SS',
};

/**
 * Folds accented Latin letters onto their base A-Z letter: Ñ→N, Ä→A, Ö→O, Ü→U, ß→SS.
 *
 * The board only has the English 144-tile A-Z set, so an accented letter is literally
 * unplayable. Folding keeps those words in the game (it's worth ~22% of the German list and
 * ~193% of Turkish, were we to add it) instead of silently dropping every word containing one.
 * It's also the convention the French ODS8 list already ships with.
 *
 * Non-Latin scripts are deliberately NOT transliterated — they come out unchanged and are then
 * rejected by WORD_PATTERN, which is the correct outcome for a game played with A-Z tiles.
 */
export function foldDiacritics(raw: string): string {
  let out = '';
  for (const ch of raw) {
    out += UNDECOMPOSABLE[ch] ?? UNDECOMPOSABLE[ch.toUpperCase()] ?? ch;
  }
  // NFD splits e.g. "E-acute" into "E" + U+0301; \p{M} strips every combining mark that
  // decomposition exposed, leaving the bare base letter.
  return out.normalize('NFD').replace(/\p{M}/gu, '');
}

/** Uppercases + trims a candidate word, folding accents onto their base letter first; returns
 * null if it still doesn't match the allowed shape (letters only, 2-20 chars) rather than
 * throwing, so callers can filter a list. Folding means a user pasting "café" into a custom set
 * now gets CAFE instead of a rejection, matching how the built-in language lists are loaded. */
export function normalizeWord(raw: string): string | null {
  const word = foldDiacritics(raw.trim()).toUpperCase();
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
 * the `_validate_dictionary_config` SQL function. `selectableCustomSetIds` is the id set the
 * caller is allowed to reference: the union of the current user's own custom set ids AND the
 * official (owner-less) language dictionary ids, which every user may select. */
export function validateDictionaryConfig(
  config: DictionaryConfig,
  selectableCustomSetIds: string[] | Set<string>,
): DictionaryConfigValidity {
  const { minLength, maxLength, baseEnabled, customSetIds, baseSetId } = config;

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

  const selectable =
    selectableCustomSetIds instanceof Set ? selectableCustomSetIds : new Set(selectableCustomSetIds);
  for (const id of customSetIds) {
    if (!selectable.has(id)) {
      return { valid: false, reason: 'INVALID_CUSTOM_SET' };
    }
  }

  // A custom base must also be one of the included sets — otherwise the union that actually
  // decides word validity wouldn't contain the base at all.
  if (baseSetId != null && !customSetIds.includes(baseSetId)) {
    return { valid: false, reason: 'INVALID_CUSTOM_SET' };
  }

  return { valid: true };
}
