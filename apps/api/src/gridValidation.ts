import type { SupabaseClient } from '@supabase/supabase-js';
import type { Letter } from '@plantain/shared';

/**
 * A player's full dealt-tile inventory, read directly via the service-role
 * client (bypasses RLS; the action RPCs themselves are locked to service_role
 * so this Worker is the only thing that can see rack contents).
 */
export async function fetchRack(
  admin: SupabaseClient,
  roomId: string,
  profileId: string,
): Promise<Letter[]> {
  const { data, error } = await admin
    .from('room_players')
    .select('rack')
    .eq('room_id', roomId)
    .eq('profile_id', profileId)
    .single();
  if (error || !data) throw new Error('NOT_A_PLAYER');
  return data.rack as Letter[];
}
