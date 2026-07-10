import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase.js';

export interface RoomEvent {
  id: number;
  room_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/** Subscribes to the public fan-out log for a room; calls onEvent for each new row. */
export function useRoomEvents(roomId: string | undefined, onEvent: (event: RoomEvent) => void) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!roomId) return;

    const channel = supabase
      .channel(`room-events-${roomId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'room_events', filter: `room_id=eq.${roomId}` },
        (payload) => handlerRef.current(payload.new as RoomEvent),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [roomId]);
}
