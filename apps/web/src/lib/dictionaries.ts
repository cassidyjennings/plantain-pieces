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

/** The built-in ENABLE1 English list — always available as a base, owned by no one. */
export const ENGLISH_BASE_LABEL = 'English';

/** Which dictionary a wordlist is built on: the built-in list, or one of your own sets. */
export type BaseSource = { kind: 'english' } | { kind: 'custom'; id: string };

/**
 * The base a config is built on. Configs written before bases existed (and any where the base
 * was implicit) fall back sensibly: base = English if it's on, else the first custom set.
 */
export function getBaseSource(config: DictionaryConfig): BaseSource | null {
  if (config.baseSetId) return { kind: 'custom', id: config.baseSetId };
  if (config.baseEnabled) return { kind: 'english' };
  if (config.customSetIds.length > 0) return { kind: 'custom', id: config.customSetIds[0] };
  return null;
}

/** The included custom sets that aren't the base — i.e. the "added on top" ones. */
export function getAdditionalSetIds(config: DictionaryConfig): string[] {
  const base = getBaseSource(config);
  if (base?.kind === 'custom') return config.customSetIds.filter((id) => id !== base.id);
  return config.customSetIds;
}

/** Swap the base, keeping the additional dictionaries. A custom base stays in customSetIds
 * so the word-validity union (which is all the SQL looks at) still contains it. */
export function withBaseSource(config: DictionaryConfig, base: BaseSource): DictionaryConfig {
  const additional = getAdditionalSetIds(config);
  if (base.kind === 'english') {
    return { ...config, baseEnabled: true, baseSetId: null, customSetIds: additional };
  }
  return {
    ...config,
    baseEnabled: false,
    baseSetId: base.id,
    customSetIds: [base.id, ...additional.filter((id) => id !== base.id)],
  };
}

/** Replace the additional dictionaries, leaving the base untouched. */
export function withAdditionalSetIds(config: DictionaryConfig, ids: string[]): DictionaryConfig {
  const base = getBaseSource(config);
  if (base?.kind === 'custom') {
    return { ...config, customSetIds: [base.id, ...ids.filter((id) => id !== base.id)] };
  }
  return { ...config, customSetIds: ids };
}

/** One-line human summary of a config, e.g. "English + 2 more · 3–8 letters". */
export function summarizeDictionaryConfig(
  config: DictionaryConfig,
  nameFor?: (id: string) => string,
): string {
  const base = getBaseSource(config);
  const additional = getAdditionalSetIds(config);
  let baseLabel: string;
  if (!base) baseLabel = 'No dictionary!';
  else if (base.kind === 'english') baseLabel = ENGLISH_BASE_LABEL;
  else baseLabel = nameFor ? nameFor(base.id) : 'Custom';

  const sources = additional.length > 0 ? `${baseLabel} + ${additional.length} more` : baseLabel;
  const lengthPart = config.maxLength
    ? `${config.minLength}–${config.maxLength} letters`
    : `${config.minLength}+ letters`;
  return `${sources} · ${lengthPart}`;
}

export async function fetchMyDictionaryPresets(): Promise<DictionaryPresetRow[]> {
  const { data, error } = await supabase
    .from('dictionary_presets')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) return [];
  return data as DictionaryPresetRow[];
}
