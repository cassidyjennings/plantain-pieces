-- The Worker now emits the `game_over` event itself (after archiving), so it can include
-- the archived gameId in the payload — every client (winner + losers) learns where to POST
-- its end-of-game summary from that one event. Override finish_game to stop emitting its own
-- game_over; behavior is otherwise identical. (finish_game stays service_role-only; the
-- create-or-replace keeps the existing grants from 20260706000002's lockdown block.)
create or replace function public.finish_game(p_room_id uuid, p_winner uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_active int;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_room.status <> 'active' then raise exception 'GAME_NOT_ACTIVE' using errcode = 'P0001'; end if;

  select count(*) into v_active
    from public.room_players where room_id = p_room_id and not is_spectator;
  if v_room.bunch_count >= v_active then
    raise exception 'BUNCH_NOT_LOW' using errcode = 'P0001';
  end if;

  update public.rooms
    set status = 'finished', winner_id = p_winner, finished_at = now()
    where id = p_room_id;

  -- (game_over event intentionally NOT emitted here — the Worker emits it post-archival.)
  return jsonb_build_object('ok', true);
end;
$$;
