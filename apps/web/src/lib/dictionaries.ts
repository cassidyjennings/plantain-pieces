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

/** One-line human summary of a config, e.g. "Standard + 2 custom · 3–8 letters". */
export function summarizeDictionaryConfig(config: DictionaryConfig): string {
  const sources: string[] = [];
  if (config.baseEnabled) sources.push('Standard');
  if (config.customSetIds.length > 0) {
    sources.push(`${config.customSetIds.length} custom`);
  }
  const lengthPart = config.maxLength
    ? `${config.minLength}–${config.maxLength} letters`
    : `${config.minLength}+ letters`;
  return `${sources.join(' + ') || 'No dictionary!'} · ${lengthPart}`;
}

export async function fetchMyDictionaryPresets(): Promise<DictionaryPresetRow[]> {
  const { data, error } = await supabase
    .from('dictionary_presets')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) return [];
  return data as DictionaryPresetRow[];
}
