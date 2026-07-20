-- Allow a single player to Split (solo play). Previously start_game required >= 2 players;
-- this was relaxed at runtime for dev but never written to a migration, so every db reset
-- silently restored the 2-player rule. Overriding start_game here makes solo play persist.
-- Identical to the original otherwise. (start_game stays service_role-only via the existing
-- lockdown grants, which create-or-replace preserves.)
create or replace function public.start_game(p_room_id uuid, p_host uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_players int;
  v_deal int;
  v_player record;
  v_tiles text[];
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_room.host_id <> p_host then raise exception 'NOT_HOST' using errcode = 'P0001'; end if;
  if v_room.status <> 'lobby' then raise exception 'ALREADY_STARTED' using errcode = 'P0001'; end if;

  select count(*) into v_players
    from public.room_players where room_id = p_room_id and not is_spectator;
  if v_players < 1 then raise exception 'NEED_ONE_PLAYER' using errcode = 'P0001'; end if;

  v_deal := public._initial_deal(v_players);

  for v_player in
    select profile_id from public.room_players
    where room_id = p_room_id and not is_spectator order by seat
  loop
    v_tiles := public._draw_from_bunch(p_room_id, v_deal);
    update public.room_players
      set rack = to_jsonb(v_tiles), tile_count = array_length(v_tiles, 1), grid_state = '{}'::jsonb
      where room_id = p_room_id and profile_id = v_player.profile_id;
  end loop;

  update public.rooms set status = 'active', started_at = now() where id = p_room_id;

  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'game_started',
          jsonb_build_object('dealt', v_deal,
                             'bunchCount', (select bunch_count from public.rooms where id = p_room_id),
                             'tileCounts', public._tile_counts(p_room_id)));

  return jsonb_build_object('ok', true);
end;
$$;
