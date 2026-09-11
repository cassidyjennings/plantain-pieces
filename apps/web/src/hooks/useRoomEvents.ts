import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase.js';

export interface RoomEvent {
  id: number;
  room_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface RoomEventsOptions {
  /** Announce this profile's presence on the room channel, and report back who else is on it.
   * Omitted (or undefined) means "subscribe only" — Lobby/Results don't need liveness. */
  presenceId?: string;
}

export interface RoomEventsState {
  /** Profile ids currently holding an open channel to this room. Empty until presence syncs;
   * always empty when `presenceId` wasn't supplied. */
  onlineIds: Set<string>;
}

const NO_ONE: Set<string> = new Set();

/**
 * Subscribes to the public fan-out log for a room; calls onEvent for each new row.
 *
 * Postgres Changes does NOT replay rows a client missed while its socket was down, and a phone
 * backgrounding the tab drops that socket routinely. Missing a `peel` left a player's rack
 * silently short a tile (self-healing, via the server's next rejection); missing `game_over`
 * stranded them on the board after someone else had already won, with no recovery path at all.
 *
 * So every (re)subscribe runs a catch-up query over room_events — which members can already
 * read directly under RLS, and whose `id` is a monotonic bigserial — for everything newer than
 * the last event dispatched. Returning to a visible tab does the same, since a socket can go
 * quiet without the client noticing.
 *
 * Dispatch is idempotent by id: an event is delivered only if its id is strictly greater than
 * the highest already seen, so a live row and a catch-up row covering the same insert can't
 * both fire. The FIRST subscribe deliberately establishes a baseline without dispatching —
 * replaying a whole finished game on mount would re-fire callouts and re-navigate.
 */
export function useRoomEvents(
  roomId: string | undefined,
  onEvent: (event: RoomEvent) => void,
  options: RoomEventsOptions = {},
): RoomEventsState {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  const { presenceId } = options;

  const [onlineIds, setOnlineIds] = useState<Set<string>>(NO_ONE);
  /** Highest room_events.id already handed to onEvent. -1 = no baseline established yet. */
  const lastIdRef = useRef(-1);

  /** Deliver an event exactly once, in id order. */
  const dispatch = useCallback((event: RoomEvent) => {
    if (typeof event.id !== 'number' || event.id <= lastIdRef.current) return;
    lastIdRef.current = event.id;
    handlerRef.current(event);
  }, []);

  const catchUp = useCallback(
    async (id: string) => {
      if (lastIdRef.current < 0) {
        // First connection: adopt the current head as the baseline, silently. Anything that
        // happened before this hook mounted is already reflected in the snapshot the page
        // loaded alongside it.
        const { data } = await supabase
          .from('room_events')
          .select('id')
          .eq('room_id', id)
          .order('id', { ascending: false })
          .limit(1);
        const head = (data?.[0] as { id?: number } | undefined)?.id;
        if (typeof head === 'number' && head > lastIdRef.current) lastIdRef.current = head;
        return;
      }
      const { data, error } = await supabase
        .from('room_events')
        .select('*')
        .eq('room_id', id)
        .gt('id', lastIdRef.current)
        .order('id');
      if (error || !data) return;
      for (const row of data as RoomEvent[]) dispatch(row);
    },
    [dispatch],
  );

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;

    const channel = supabase.channel(`room-events-${roomId}`, {
      config: presenceId ? { presence: { key: presenceId } } : {},
    });

    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'room_events', filter: `room_id=eq.${roomId}` },
      (payload) => dispatch(payload.new as RoomEvent),
    );

    if (presenceId) {
      // Presence, not a DB column: room_players.connected has always defaulted to true and is
      // written by nothing, anywhere, so the "(disconnected)" marker in the roster could never
      // render. A channel membership set is the thing that actually knows, needs no heartbeat
      // RPC, and clears itself when a tab closes.
      channel.on('presence', { event: 'sync' }, () => {
        if (cancelled) return;
        setOnlineIds(new Set(Object.keys(channel.presenceState())));
      });
    }

    channel.subscribe((status) => {
      if (cancelled || status !== 'SUBSCRIBED') return;
      // Fires on the first join AND on every automatic rejoin after a drop — which is exactly
      // when rows may have been missed.
      void catchUp(roomId);
      if (presenceId) void channel.track({ at: Date.now() });
    });

    const onVisible = () => {
      if (document.visibilityState === 'visible') void catchUp(roomId);
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      supabase.removeChannel(channel);
    };
  }, [roomId, presenceId, dispatch, catchUp]);

  return { onlineIds };
}
