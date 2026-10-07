-- Solo peel batches: in solo, a Peel draws N tiles (1-7, chosen at setup) instead of 1.
--
-- Storage: rooms.mode_config.peelBatch, camelCase like the bunchSize/timed keys already beside it
-- (and so Results' rematch, which passes an old room's mode_config straight back as a
-- SoloModeConfig, round-trips it). Absent on every room created before this migration -> 1.
--
-- create_solo_room needs a new argument, so it is DROPPED and recreated rather than overloaded:
-- a 5-argument call would be ambiguous between a 5-arg function and a 6-arg one with a default
-- (same reasoning as 20260911000002_daily_local_date). The default also lets the Worker that is
-- still deployed when this runs keep calling with five named arguments. A recreated function
-- loses its grants, so they are restated at the bottom.
--
-- peel keeps its exact signature (create or replace). Only a new mode = 'solo' branch is added,
-- and every other mode runs the same code as before. The solo gate is bunch_count >= 1. That is
-- already what the old gate computed for a single player, but it is now explicit, so a solo
-- room's "can peel" no longer depends on its player count. The peel event also gains 'drawn'
-- (tiles the caller just received), computed as a tile_count delta so it is right for every
-- mode.

drop function if exists public.create_solo_room(uuid, text, jsonb, int, boolean);

create or replace function public.create_solo_room(
  p_host uuid, p_display_name text, p_dictionary_config jsonb, p_bunch_size int, p_timed boolean,
  p_peel_batch int default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_room_id uuid;
  v_config jsonb;
  v_bunch jsonb;
  v_deal int;
  v_tiles text[];
  v_peel_batch int;
begin
  perform public._sweep_stale_rooms();

  if p_bunch_size < 40 or p_bunch_size > 144 then
    raise exception 'INVALID_BUNCH_SIZE' using errcode = 'P0001';
  end if;

  -- Clamped, not rejected: the Worker already 400s an out-of-range value (shared
  -- validateSoloModeConfig); this is the last line of defence. Twin of clampPeelBatch in
  -- packages/shared/src/solo.ts.
  v_peel_batch := least(7, greatest(1, coalesce(p_peel_batch, 1)));

  v_config := coalesce(p_dictionary_config,
    '{"minLength":2,"maxLength":null,"baseEnabled":true,"excludedTopics":[],"customSetIds":[]}'::jsonb);
  v_bunch := public._scaled_bunch(p_bunch_size);

  loop
    v_code := (
      select string_agg(
        substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789',
               (floor(random() * length('ABCDEFGHJKMNPQRSTUVWXYZ23456789')) + 1)::int, 1),
        '')
      from generate_series(1, 6)
    );
    exit when not exists (select 1 from public.rooms where code = v_code);
  end loop;

  insert into public.rooms (
    code, host_id, dictionary_config, bunch, bunch_count,
    mode, mode_config, status, started_at
  ) values (
    v_code, p_host, v_config, v_bunch, p_bunch_size,
    'solo', jsonb_build_object('bunchSize', p_bunch_size, 'timed', p_timed, 'peelBatch', v_peel_batch),
    'active', now()
  ) returning id into v_room_id;

  insert into public.room_players (room_id, profile_id, display_name, seat)
  values (v_room_id, p_host, p_display_name, 0);

  insert into public.room_events (room_id, type, payload)
  values (v_room_id, 'player_joined',
          jsonb_build_object('profileId', p_host, 'displayName', p_display_name, 'seat', 0));

  v_deal := public._initial_deal(1);
  v_tiles := public._draw_from_bunch(v_room_id, v_deal);
  update public.room_players
    set rack = to_jsonb(v_tiles), tile_count = array_length(v_tiles, 1), grid_state = '{}'::jsonb
    where room_id = v_room_id and profile_id = p_host;

  insert into public.room_events (room_id, type, payload)
  values (v_room_id, 'game_started',
          jsonb_build_object('dealt', v_deal,
                             'bunchCount', (select bunch_count from public.rooms where id = v_room_id),
                             'tileCounts', public._tile_counts(v_room_id)));

  return jsonb_build_object('roomId', v_room_id, 'code', v_code, 'seat', 0,
                            'bunchSize', p_bunch_size, 'timed', p_timed, 'peelBatch', v_peel_batch);
end;
$$;

-- ---------------------------------------------------------------------------
-- peel — same body as 20260818000001_rack_version, + solo batch branch, + explicit solo gate,
-- + 'drawn' in the event payload.
-- ---------------------------------------------------------------------------
create or replace function public.peel(p_room_id uuid, p_profile uuid, p_expected_count int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_active int;
  v_caller public.room_players;
  v_player record;
  v_tiles text[];
  v_new_rack jsonb;
  v_new_rack_version int;
  v_new_tile_count int;
  v_partner uuid;
  v_step int;
  v_batch int;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_room.status <> 'active' then raise exception 'GAME_NOT_ACTIVE' using errcode = 'P0001'; end if;

  select * into v_caller from public.room_players
    where room_id = p_room_id and profile_id = p_profile and not is_spectator;
  if not found then raise exception 'NOT_A_PLAYER' using errcode = 'P0001'; end if;
  if v_caller.tile_count <> p_expected_count then
    raise exception 'STALE_ACTION' using errcode = 'P0001';
  end if;

  select count(*) into v_active
    from public.room_players where room_id = p_room_id and not is_spectator;

  -- Solo draws least(peelBatch, bunch_count), so a single remaining tile is still a legal final
  -- Peel. Every other mode deals 1 to each active player and needs one tile per player.
  -- Client twin: peelThreshold() in packages/shared/src/solo.ts.
  if v_room.bunch_count < (case when v_room.mode = 'solo' then 1 else v_active end) then
    raise exception 'BUNCH_TOO_LOW' using errcode = 'P0001';
  end if;

  if v_room.mode = 'xtina' then
    v_partner := (v_room.mode_config ->> 'partnerId')::uuid;
    v_step := (v_room.mode_config ->> 'step')::int + 1;
    if v_step > 10 then
      raise exception 'XTINA_SCRIPT_EXHAUSTED' using errcode = 'P0001';
    end if;

    -- Partner: the next word's letters.
    v_tiles := public._xtina_step_letters(v_step);
    perform public._xtina_take(p_room_id, v_tiles);
    update public.room_players rp
      set rack = rp.rack || to_jsonb(v_tiles),
          tile_count = rp.tile_count + coalesce(array_length(v_tiles, 1), 0),
          rack_version = rp.rack_version + 1
      where rp.room_id = p_room_id and rp.profile_id = v_partner;

    -- Owner: one more junk tile. Index 5 was the last dealt at Split, so step 2 draws index 6.
    v_tiles := array[public._xtina_owner_tile(4 + v_step)];
    perform public._xtina_take(p_room_id, v_tiles);
    update public.room_players rp
      set rack = rp.rack || to_jsonb(v_tiles),
          tile_count = rp.tile_count + 1,
          rack_version = rp.rack_version + 1
      where rp.room_id = p_room_id and rp.profile_id = v_room.host_id;

    update public.rooms
      set mode_config = jsonb_set(mode_config, '{step}', to_jsonb(v_step))
      where id = p_room_id;
  elsif v_room.mode = 'solo' then
    -- Rooms created before 20261006000003 have no peelBatch key -> 1, i.e. the old behaviour.
    -- Same clamp as create_solo_room, so a hand-edited mode_config can't over- or under-draw.
    v_batch := least(7, greatest(1, coalesce((v_room.mode_config ->> 'peelBatch')::int, 1)));
    -- The last Peel takes the remainder: fewer than v_batch left -> draw them all.
    v_tiles := public._draw_from_bunch(p_room_id, least(v_batch, v_room.bunch_count));
    update public.room_players rp
      set rack = rp.rack || to_jsonb(v_tiles),
          tile_count = rp.tile_count + coalesce(array_length(v_tiles, 1), 0),
          rack_version = rp.rack_version + 1
      where rp.room_id = p_room_id and rp.profile_id = p_profile;
  else
    for v_player in
      select profile_id from public.room_players
      where room_id = p_room_id and not is_spectator order by seat
    loop
      v_tiles := public._draw_from_bunch(p_room_id, 1);
      update public.room_players rp
        set rack = rp.rack || to_jsonb(v_tiles),
            tile_count = rp.tile_count + coalesce(array_length(v_tiles, 1), 0),
            rack_version = rp.rack_version + 1
        where rp.room_id = p_room_id and rp.profile_id = v_player.profile_id;
    end loop;
  end if;

  select rack, rack_version, tile_count into v_new_rack, v_new_rack_version, v_new_tile_count
    from public.room_players
    where room_id = p_room_id and profile_id = p_profile;

  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'peel',
          jsonb_build_object('actor', p_profile,
                             'drawn', v_new_tile_count - v_caller.tile_count,
                             'bunchCount', (select bunch_count from public.rooms where id = p_room_id),
                             'tileCounts', public._tile_counts(p_room_id)));

  return jsonb_build_object('ok', true, 'rack', v_new_rack, 'rackVersion', v_new_rack_version,
                            'bunchCount', (select bunch_count from public.rooms where id = p_room_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. peel kept its signature, so create or replace kept its grants. create_solo_room was
-- recreated, and a new function is executable by PUBLIC until revoked.
-- ---------------------------------------------------------------------------
do $$
begin
  execute 'revoke all on function public.create_solo_room(uuid,text,jsonb,int,boolean,int) from public, anon, authenticated';
  execute 'grant execute on function public.create_solo_room(uuid,text,jsonb,int,boolean,int) to service_role';
end $$;
