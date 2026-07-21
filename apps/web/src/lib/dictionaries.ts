import type { DictionaryConfig } from '@plantain/shared';
import { supabase } from './supabase.js';

export interface CustomWordSetSummary {
  id: string;
  owner_id: string;
  name: string;
  created_at: string;
  word_count: number;
}

export interface DictionaryPresetRow {
  id: string;
  owner_id: string;
  name: string;
  config: DictionaryConfig;
  created_at: string;
}

/** Pure owner-scoped reads, gated by RLS — no Worker round-trip needed (writes still
 * go through the Worker; see lib/api.ts). Mirrors the direct-read pattern in rooms.ts. */

export async function fetchMyCustomWordSets(): Promise<CustomWordSetSummary[]> {
  const { data, error } = await supabase
    .from('custom_word_sets_with_count')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) return [];
  return data as CustomWordSetSummary[];
}

/** Lazy word-content fetch — only called when a set is actually opened for editing,
 * never bulk-loaded alongside the summary list. */
export async function fetchCustomWordSetWords(setId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('words')
    .select('word')
    .eq('custom_set_id', setId)
    .order('word');
  if (error) return [];
  return (data as { word: string }[]).map((row) => row.word);
}

/** The built-in word list — always selectable, owned by no one. Deliberately generic (no
 * mention of the underlying ENABLE1 source list) since players don't need to know or care
 * which public-domain list backs it. */
export const STANDARD_DICTIONARY_LABEL = 'Standard Dictionary';

/** Every dictionary currently included in a config: the built-in list (if enabled) plus every
 * custom set, with no "base vs additional" distinction — a wordlist is just a set of one or
 * more dictionaries chosen from a flat checklist. */
export function getIncludedSetIds(config: DictionaryConfig): string[] {
  return config.customSetIds;
}

/** Toggle a single custom set's inclusion. */
export function withSetIncluded(config: DictionaryConfig, id: string, included: boolean): DictionaryConfig {
  const customSetIds = included
    ? [...config.customSetIds, id]
    : config.customSetIds.filter((x) => x !== id);
  // baseSetId is a legacy display-only field from when configs had a distinguished "base";
  // clear it so it never points at something the union no longer contains.
  return { ...config, customSetIds, baseSetId: null };
}

/** Toggle whether the built-in dictionary is included. */
export function withStandardIncluded(config: DictionaryConfig, included: boolean): DictionaryConfig {
  return { ...config, baseEnabled: included, baseSetId: null };
}

/** One-line human summary of a config, e.g. "Standard Dictionary + 2 more · 3–8 letters". */
export function summarizeDictionaryConfig(
  config: DictionaryConfig,
  nameFor?: (id: string) => string,
): string {
  const names: string[] = [];
  if (config.baseEnabled) names.push(STANDARD_DICTIONARY_LABEL);
  for (const id of config.customSetIds) names.push(nameFor ? nameFor(id) : 'Custom');

  const sources =
    names.length === 0
      ? 'No dictionary selected!'
      : names.length <= 2
        ? names.join(' + ')
        : `${names[0]} + ${names.length - 1} more`;
  const lengthPart = config.maxLength
    ? `${config.minLength}–${config.maxLength} letters`
    : `${config.minLength}+ letters`;
  return `${sources} · ${lengthPart}`;
}

/** Normalizes the fields that actually affect word validity/length for preset-equality checks —
 * ignores customSetIds ordering and the legacy display-only baseSetId field. */
function normalizeForCompare(config: DictionaryConfig): string {
  return JSON.stringify({
    minLength: config.minLength,
    maxLength: config.maxLength,
    baseEnabled: config.baseEnabled,
    customSetIds: [...config.customSetIds].sort(),
  });
}

/**
 * The label for the "Dictionaries" button: the dictionary's own name if exactly one is
 * selected, a count if two or more are, or a matching saved preset's name in place of either
 * (so applying a preset shows the name you gave it, not a breakdown of what's in it).
 */
export function getDictionaryButtonLabel(
  config: DictionaryConfig,
  nameFor: (id: string) => string,
  presets?: DictionaryPresetRow[],
): string {
  if (presets) {
    const match = presets.find((p) => normalizeForCompare(p.config) === normalizeForCompare(config));
    if (match) return match.name;
  }

  const names: string[] = [];
  if (config.baseEnabled) names.push(STANDARD_DICTIONARY_LABEL);
  for (const id of config.customSetIds) names.push(nameFor(id));

  if (names.length === 0) return 'Choose Dictionaries';
  if (names.length === 1) return names[0];
  return `${names.length} Dictionaries`;
}

export async function fetchMyDictionaryPresets(): Promise<DictionaryPresetRow[]> {
  const { data, error } = await supabase
    .from('dictionary_presets')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) return [];
  return data as DictionaryPresetRow[];
}
