-- Fixes "all tiles placed, no Peel" soft-lock: the client rack was rebuilt wholesale from
-- three unordered async responses (own peel/dump result, a foreign-peel getMyState refetch),
-- with nothing to tell an older response from a newer one. When the older one lands last, it
-- silently overwrites a newer rack and the client permanently forgets a tile it actually has.
-- The client's own validateStructure can never catch this -- it derives its expected inventory
-- from its own (wrong) rack, so it always reports "complete." Only the server, which reads the
-- real rack, rejects the Peel, and that rejection is in SILENT_ACTION_ERRORS (correctly, for
-- the normal "board not finished yet" case) -- so the wrong-and-complete-looking board just
-- sits there with no feedback until a later foreign peel happens to refetch and heal it.
--
-- Root-cause fix: version every room_players row's rack. peel/dump/get_my_state now return
-- rackVersion; the client drops any response whose version isn't newer than what it already
-- applied, so a stale-but-late response can no longer clobber a fresher one.

alter table public.room_players add column rack_version int not null default 0;

-- ---------------------------------------------------------------------------
-- peel — same body as 20260805000002, +rack_version bump on every rack write, +rackVersion
-- in the return payload.
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
  v_partner uuid;
  v_step int;
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

  if v_room.bunch_count < v_active then
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

  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'peel',
          jsonb_build_object('actor', p_profile,
                             'bunchCount', (select bunch_count from public.rooms where id = p_room_id),
                             'tileCounts', public._tile_counts(p_room_id)));

  select rack, rack_version into v_new_rack, v_new_rack_version from public.room_players
    where room_id = p_room_id and profile_id = p_profile;
  return jsonb_build_object('ok', true, 'rack', v_new_rack, 'rackVersion', v_new_rack_version,
                            'bunchCount', (select bunch_count from public.rooms where id = p_room_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- dump — same body as 20260706000002, +rack_version bump, +rackVersion in the return payload.
-- ---------------------------------------------------------------------------
create or replace function public.dump(p_room_id uuid, p_profile uuid, p_tile text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_caller public.room_players;
  v_idx int;
  v_rack jsonb;
  v_drawn text[];
  v_rack_version int;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_room.status <> 'active' then raise exception 'GAME_NOT_ACTIVE' using errcode = 'P0001'; end if;
  if v_room.bunch_count < 3 then raise exception 'BUNCH_TOO_LOW' using errcode = 'P0001'; end if;

  select * into v_caller from public.room_players
    where room_id = p_room_id and profile_id = p_profile and not is_spectator;
  if not found then raise exception 'NOT_A_PLAYER' using errcode = 'P0001'; end if;

  -- Find and remove one instance of p_tile from the caller's rack.
  v_rack := v_caller.rack;
  select ord - 1 into v_idx
    from jsonb_array_elements_text(v_rack) with ordinality as t(letter, ord)
    where t.letter = upper(p_tile)
    limit 1;
  if v_idx is null then raise exception 'TILE_NOT_HELD' using errcode = 'P0001'; end if;
  v_rack := v_rack - v_idx;  -- remove element at index

  -- Return the dumped tile to the Bunch, then draw three.
  update public.rooms
    set bunch = jsonb_set(bunch, array[upper(p_tile)],
                          to_jsonb(coalesce((bunch ->> upper(p_tile))::int, 0) + 1)),
        bunch_count = bunch_count + 1
    where id = p_room_id;

  v_drawn := public._draw_from_bunch(p_room_id, 3);
  v_rack := v_rack || to_jsonb(v_drawn);

  update public.room_players
    set rack = v_rack, tile_count = jsonb_array_length(v_rack), rack_version = rack_version + 1
    where room_id = p_room_id and profile_id = p_profile
    returning rack_version into v_rack_version;

  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'dump',
          jsonb_build_object('actor', p_profile,
                             'bunchCount', (select bunch_count from public.rooms where id = p_room_id),
                             'tileCounts', public._tile_counts(p_room_id)));

  return jsonb_build_object('ok', true, 'rack', v_rack, 'rackVersion', v_rack_version,
                            'bunchCount', (select bunch_count from public.rooms where id = p_room_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- get_my_state — same body as 20260706000002, +rackVersion in the return payload.
-- ---------------------------------------------------------------------------
create or replace function public.get_my_state(p_room_id uuid, p_profile uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_rp public.room_players;
begin
  select * into v_rp from public.room_players
    where room_id = p_room_id and profile_id = p_profile;
  if not found then raise exception 'NOT_IN_ROOM' using errcode = 'P0002'; end if;
  return jsonb_build_object('rack', v_rp.rack, 'rackVersion', v_rp.rack_version,
                            'grid', v_rp.grid_state, 'tileCount', v_rp.tile_count, 'seat', v_rp.seat);
end;
$$;
