import type { AvatarConfig, DictionaryConfig, SoloModeConfig } from '@plantain/shared';
import { supabase } from './supabase.js';

export interface PublicRoom {
  id: string;
  code: string;
  host_id: string;
  status: 'lobby' | 'active' | 'finished';
  dictionary_config: DictionaryConfig;
  bunch_count: number;
  winner_id: string | null;
  mode: 'multiplayer' | 'solo';
  mode_config: SoloModeConfig | Record<string, never>;
  started_at: string | null;
}

export interface PublicPlayer {
  room_id: string;
  profile_id: string;
  display_name: string;
  seat: number;
  is_ready: boolean;
  is_spectator: boolean;
  tile_count: number;
  connected: boolean;
  avatar_config: AvatarConfig;
}

export async function fetchRoom(roomId: string): Promise<PublicRoom | null> {
  const { data, error } = await supabase.from('rooms_public').select('*').eq('id', roomId).single();
  if (error) return null;
  return data as PublicRoom;
}

export async function fetchPlayers(roomId: string): Promise<PublicPlayer[]> {
  const { data, error } = await supabase
    .from('room_players_public')
    .select('*')
    .eq('room_id', roomId)
    .order('seat');
  if (error) return [];
  return data as PublicPlayer[];
}

/** Who peeled most recently, from the event log — so a player joining or reloading mid-game
 * sees the current state rather than waiting for the next live peel. */
export async function fetchLastPeelActor(roomId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('room_events')
    .select('payload')
    .eq('room_id', roomId)
    .eq('type', 'peel')
    .order('id', { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  return ((data[0].payload as { actor?: string }).actor) ?? null;
}

export async function fetchDisplayName(profileId: string): Promise<string> {
  const { data } = await supabase.from('profiles').select('display_name').eq('id', profileId).single();
  return data?.display_name ?? 'Player';
}
