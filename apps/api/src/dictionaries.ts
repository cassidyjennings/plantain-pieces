import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A caller's own custom-set ids, read directly via the service-role client. Used to give
 * an early, cheap 400 (via shared's validateDictionaryConfig) before the round-trip to the
 * RPC, which remains the authoritative check regardless — this is defense-in-depth, not a
 * replacement for it.
 */
export async function fetchOwnedCustomSetIds(admin: SupabaseClient, ownerId: string): Promise<string[]> {
  const { data, error } = await admin.from('custom_word_sets').select('id').eq('owner_id', ownerId);
  if (error) throw new Error('FAILED_TO_LOAD_OWNED_SETS');
  return (data ?? []).map((row) => row.id as string);
}

/**
 * Resolves {id, name} pairs for the custom set ids currently active in a room's
 * dictionary_config, via the service-role key. RLS correctly hides other users' custom
 * word sets from a non-host client reading the room's public config directly, but that
 * means a non-host would otherwise only see raw UUIDs for the host's sets — this is the
 * one deliberate, narrow bypass: it only ever resolves the ids already public in *that
 * room's* config, never an arbitrary lookup.
 */
export async function resolveCustomSetNames(
  admin: SupabaseClient,
  roomId: string,
): Promise<{ id: string; name: string }[]> {
  const { data: room, error: roomError } = await admin
    .from('rooms')
    .select('dictionary_config')
    .eq('id', roomId)
    .single();
  if (roomError || !room) throw new Error('ROOM_NOT_FOUND');

  const customSetIds = (room.dictionary_config?.customSetIds ?? []) as string[];
  if (customSetIds.length === 0) return [];

  const { data, error } = await admin
    .from('custom_word_sets')
    .select('id, name')
    .in('id', customSetIds);
  if (error) throw new Error('FAILED_TO_RESOLVE_SET_NAMES');
  return (data ?? []) as { id: string; name: string }[];
}
