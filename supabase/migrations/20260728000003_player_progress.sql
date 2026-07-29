-- Per-player tile counts didn't make sense: the opponent pills showed tile_count, which is
-- jsonb_array_length(rack) -- a player's WHOLE inventory, placed or not. It only moves on
-- Peel/Dump, so it read ~21 all game regardless of how much of the board they'd actually filled
-- in. The local player also had no pill at all (Game.tsx's `opponents` list filters self out).
--
-- The number players actually want -- tiles remaining = tray tiles + placed tiles not currently
-- part of a valid word -- is private client state (the server deliberately never tracks
-- placement in real time, see CLAUDE.md's "server-side state model" note), so it has to be
-- published deliberately. A plain count leaks nothing about letters or board layout.

-- ---------------------------------------------------------------------------
-- remaining_count: null until a player's client has reported at least once (a rejoining/
-- reloading player, or one on an old client build) -- the UI falls back to tile_count while null
-- so nothing renders blank.
-- ---------------------------------------------------------------------------
alter table public.room_players
  add column remaining_count int;

-- Append remaining_count to the public view (new column at the end — allowed by REPLACE; no
-- re-grant needed, the same pattern 20260719000005 already used for avatar_config).
create or replace view public.room_players_public
with (security_invoker = false) as
  select rp.room_id, rp.profile_id, rp.display_name, rp.seat,
         rp.is_ready, rp.is_spectator, rp.tile_count, rp.connected, rp.joined_at,
         rp.avatar_config, rp.remaining_count
  from public.room_players rp
  where public.is_room_member(rp.room_id);

-- ---------------------------------------------------------------------------
-- report_progress — the client calls this (debounced) whenever its local remaining-tile count
-- changes. Dedupes in SQL: only writes and broadcasts when the value actually changed, so a
-- chatty client can't spam room_events with identical numbers.
-- ---------------------------------------------------------------------------
create or replace function public.report_progress(p_room_id uuid, p_profile uuid, p_remaining int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev int;
begin
  if p_remaining is null or p_remaining < 0 then
    raise exception 'INVALID_REMAINING' using errcode = 'P0001';
  end if;

  select remaining_count into v_prev from public.room_players
    where room_id = p_room_id and profile_id = p_profile
    for update;
  if not found then raise exception 'NOT_IN_ROOM' using errcode = 'P0002'; end if;

  if v_prev is distinct from p_remaining then
    update public.room_players set remaining_count = p_remaining
      where room_id = p_room_id and profile_id = p_profile;
    insert into public.room_events (room_id, type, payload)
      values (p_room_id, 'progress', jsonb_build_object('profileId', p_profile, 'remaining', p_remaining));
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

do $$
begin
  execute 'revoke all on function public.report_progress(uuid,uuid,integer) from public, anon, authenticated';
  execute 'grant execute on function public.report_progress(uuid,uuid,integer) to service_role';
end $$;

-- ---------------------------------------------------------------------------
-- start_game — same as 20260720000002, plus clearing remaining_count back to null on every
-- fresh deal. Without this, a rematched room's players keep showing their PREVIOUS game's final
-- number for the second or so before their client's first debounced report of the new game
-- lands -- a stale "0 left" flashing right as a brand-new hand is dealt.
-- ---------------------------------------------------------------------------
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
      set rack = to_jsonb(v_tiles), tile_count = array_length(v_tiles, 1), grid_state = '{}'::jsonb,
          remaining_count = null
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
