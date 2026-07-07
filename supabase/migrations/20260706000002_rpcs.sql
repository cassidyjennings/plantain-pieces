-- Plantain Pieces — authoritative game RPCs.
-- All are SECURITY DEFINER and intended to be called by the Worker (service_role).
-- Bunch mutations take a row lock on the room so concurrent Peels can never
-- double-draw. Structural grid validation (connectivity/orphans/multiset) is done
-- in the Worker using @plantain/shared; these RPCs own the Bunch, persistence,
-- lifecycle transitions, and the dictionary lookup.

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

-- A fresh full Bunch (standard Bananagrams 144-tile distribution).
create or replace function public._fresh_bunch()
returns jsonb language sql immutable as $$
  select '{"A":13,"B":3,"C":3,"D":6,"E":18,"F":3,"G":4,"H":3,"I":12,"J":2,"K":2,
           "L":5,"M":3,"N":8,"O":11,"P":3,"Q":2,"R":9,"S":6,"T":9,"U":6,"V":3,
           "W":3,"X":2,"Y":3,"Z":2}'::jsonb;
$$;

-- Tiles dealt to each player at Split, by player count (2–4→21, 5–6→15, 7–8→11).
create or replace function public._initial_deal(p_players int)
returns int language sql immutable as $$
  select case
    when p_players <= 4 then 21
    when p_players <= 6 then 15
    else 11
  end;
$$;

-- Draw up to p_n tiles from a room's Bunch. ASSUMES the caller already holds the
-- room row lock in this transaction. Mutates rooms.bunch / bunch_count.
create or replace function public._draw_from_bunch(p_room_id uuid, p_n int)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  b jsonb;
  cnt int;
  drawn text[] := '{}';
  i int;
  idx int;
  acc int;
  chosen text;
  rec record;
begin
  select bunch, bunch_count into b, cnt from public.rooms where id = p_room_id;
  for i in 1 .. p_n loop
    exit when cnt <= 0;
    idx := floor(random() * cnt)::int;      -- 0 .. cnt-1, uniform
    acc := 0;
    chosen := null;
    for rec in select key, value::int as v from jsonb_each_text(b) order by key loop
      if idx < acc + rec.v then
        chosen := rec.key;
        exit;
      end if;
      acc := acc + rec.v;
    end loop;
    b := jsonb_set(b, array[chosen], to_jsonb((b ->> chosen)::int - 1));
    cnt := cnt - 1;
    drawn := array_append(drawn, chosen);
  end loop;
  update public.rooms set bunch = b, bunch_count = cnt where id = p_room_id;
  return drawn;
end;
$$;

-- Compact public snapshot of per-player tile counts, for event payloads.
create or replace function public._tile_counts(p_room_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'profileId', profile_id, 'seat', seat, 'tileCount', tile_count
    ) order by seat),
    '[]'::jsonb)
  from public.room_players
  where room_id = p_room_id and not is_spectator;
$$;

-- ---------------------------------------------------------------------------
-- Room lifecycle
-- ---------------------------------------------------------------------------

create or replace function public.create_room(
  p_host uuid, p_display_name text, p_config jsonb default null
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
begin
  v_config := coalesce(p_config,
    '{"minLength":2,"maxLength":null,"baseEnabled":true,"excludedTopics":[],"customSetIds":[]}'::jsonb);

  -- Generate a unique 6-char code from an unambiguous alphabet (no 0/O/1/I/L).
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

  insert into public.rooms (code, host_id, dictionary_config, bunch, bunch_count)
  values (v_code, p_host, v_config, public._fresh_bunch(), 144)
  returning id into v_room_id;

  insert into public.room_players (room_id, profile_id, display_name, seat)
  values (v_room_id, p_host, p_display_name, 0);

  insert into public.room_events (room_id, type, payload)
  values (v_room_id, 'player_joined',
          jsonb_build_object('profileId', p_host, 'displayName', p_display_name, 'seat', 0));

  return jsonb_build_object('roomId', v_room_id, 'code', v_code, 'seat', 0);
end;
$$;

create or replace function public.join_room(
  p_code text, p_profile uuid, p_display_name text, p_spectator boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_seat int;
  v_existing public.room_players;
  v_player_count int;
begin
  select * into v_room from public.rooms where code = upper(p_code) for update;
  if not found then
    raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Rejoin: return existing seat idempotently.
  select * into v_existing from public.room_players
    where room_id = v_room.id and profile_id = p_profile;
  if found then
    return jsonb_build_object('roomId', v_room.id, 'code', v_room.code,
                              'seat', v_existing.seat, 'status', v_room.status);
  end if;

  if not p_spectator then
    if v_room.status <> 'lobby' then
      raise exception 'GAME_ALREADY_STARTED' using errcode = 'P0001';
    end if;
    select count(*) into v_player_count
      from public.room_players where room_id = v_room.id and not is_spectator;
    if v_player_count >= 8 then
      raise exception 'ROOM_FULL' using errcode = 'P0001';
    end if;
  end if;

  select coalesce(max(seat), -1) + 1 into v_seat
    from public.room_players where room_id = v_room.id;

  insert into public.room_players (room_id, profile_id, display_name, seat, is_spectator)
  values (v_room.id, p_profile, p_display_name, v_seat, p_spectator);

  insert into public.room_events (room_id, type, payload)
  values (v_room.id, 'player_joined',
          jsonb_build_object('profileId', p_profile, 'displayName', p_display_name,
                             'seat', v_seat, 'spectator', p_spectator));

  return jsonb_build_object('roomId', v_room.id, 'code', v_room.code,
                            'seat', v_seat, 'status', v_room.status);
end;
$$;

create or replace function public.set_ready(p_room_id uuid, p_profile uuid, p_ready boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.room_players set is_ready = p_ready
    where room_id = p_room_id and profile_id = p_profile;
  if not found then
    raise exception 'NOT_IN_ROOM' using errcode = 'P0002';
  end if;
  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'ready_changed',
          jsonb_build_object('profileId', p_profile, 'ready', p_ready));
  return jsonb_build_object('ok', true);
end;
$$;

-- Split!: host deals the initial hand to every seated (non-spectator) player.
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
  if v_players < 2 then raise exception 'NEED_TWO_PLAYERS' using errcode = 'P0001'; end if;

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

-- ---------------------------------------------------------------------------
-- In-game actions (structural validation performed by the Worker beforehand)
-- ---------------------------------------------------------------------------

-- Peel!: caller has emptied their rack onto a valid grid → everyone draws 1.
-- p_expected_count = the caller's tile_count the Worker validated against, used as
-- an optimistic guard against a double-peel race.
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

  -- Cannot peel once the Bunch can't give everyone a tile — race for Plantains instead.
  if v_room.bunch_count < v_active then
    raise exception 'BUNCH_TOO_LOW' using errcode = 'P0001';
  end if;

  for v_player in
    select profile_id from public.room_players
    where room_id = p_room_id and not is_spectator order by seat
  loop
    v_tiles := public._draw_from_bunch(p_room_id, 1);
    update public.room_players rp
      set rack = rp.rack || to_jsonb(v_tiles),
          tile_count = rp.tile_count + coalesce(array_length(v_tiles, 1), 0)
      where rp.room_id = p_room_id and rp.profile_id = v_player.profile_id;
  end loop;

  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'peel',
          jsonb_build_object('actor', p_profile,
                             'bunchCount', (select bunch_count from public.rooms where id = p_room_id),
                             'tileCounts', public._tile_counts(p_room_id)));

  select rack into v_new_rack from public.room_players
    where room_id = p_room_id and profile_id = p_profile;
  return jsonb_build_object('ok', true, 'rack', v_new_rack,
                            'bunchCount', (select bunch_count from public.rooms where id = p_room_id));
end;
$$;

-- Dump!: return one owned tile, draw three (requires ≥3 tiles in the Bunch).
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
  v_b jsonb;
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
    set rack = v_rack, tile_count = jsonb_array_length(v_rack)
    where room_id = p_room_id and profile_id = p_profile;

  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'dump',
          jsonb_build_object('actor', p_profile,
                             'bunchCount', (select bunch_count from public.rooms where id = p_room_id),
                             'tileCounts', public._tile_counts(p_room_id)));

  return jsonb_build_object('ok', true, 'rack', v_rack,
                            'bunchCount', (select bunch_count from public.rooms where id = p_room_id));
end;
$$;

-- Plantains!: Worker has already confirmed structural + dictionary validity.
-- This atomically ends the game for the first valid caller.
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

  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'game_over', jsonb_build_object('winner', p_winner));

  return jsonb_build_object('ok', true);
end;
$$;

-- Dictionary check honoring the room's config. Returns the words NOT accepted.
create or replace function public.find_invalid_words(p_room_id uuid, p_words text[])
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  cfg jsonb;
  min_len int;
  max_len int;
  base_enabled boolean;
  custom_ids uuid[];
  invalid text[];
begin
  select dictionary_config into cfg from public.rooms where id = p_room_id;
  if cfg is null then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;

  min_len := coalesce((cfg ->> 'minLength')::int, 2);
  max_len := nullif(cfg ->> 'maxLength', 'null')::int;
  base_enabled := coalesce((cfg ->> 'baseEnabled')::boolean, true);
  select coalesce(array_agg(value::uuid), '{}')
    into custom_ids
    from jsonb_array_elements_text(coalesce(cfg -> 'customSetIds', '[]'::jsonb));

  select coalesce(array_agg(w), '{}')
    into invalid
  from unnest(p_words) as w
  where not exists (
    select 1 from public.words dw
    where dw.word = w::citext
      and char_length(w) >= min_len
      and (max_len is null or char_length(w) <= max_len)
      and (
        (base_enabled and dw.custom_set_id is null)
        or dw.custom_set_id = any (custom_ids)
      )
  );
  return invalid;
end;
$$;

-- Persist a player's grid for reconnect (best-effort; not used for validation).
create or replace function public.persist_grid(p_room_id uuid, p_profile uuid, p_grid jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.room_players set grid_state = p_grid
    where room_id = p_room_id and profile_id = p_profile;
  return jsonb_build_object('ok', true);
end;
$$;

-- Caller's own private state (rack + grid). Used after Peel and on reconnect.
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
  return jsonb_build_object('rack', v_rp.rack, 'grid', v_rp.grid_state,
                            'tileCount', v_rp.tile_count, 'seat', v_rp.seat);
end;
$$;

-- Generic public broadcast (failed Plantains, emoji reactions later). Worker-only.
create or replace function public.append_room_event(p_room_id uuid, p_type text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.room_events (room_id, type, payload)
  values (p_room_id, p_type, coalesce(p_payload, '{}'::jsonb));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock down action RPCs: callable only by the Worker (service_role), never by
-- clients directly via PostREST. (is_room_member stays open — RLS/views need it.)
-- ---------------------------------------------------------------------------
do $$
declare
  fn text;
  action_fns text[] := array[
    'create_room(uuid,text,jsonb)', 'join_room(text,uuid,text,boolean)',
    'set_ready(uuid,uuid,boolean)', 'start_game(uuid,uuid)',
    'peel(uuid,uuid,integer)', 'dump(uuid,uuid,text)', 'finish_game(uuid,uuid)',
    'find_invalid_words(uuid,text[])', 'persist_grid(uuid,uuid,jsonb)',
    'get_my_state(uuid,uuid)', 'append_room_event(uuid,text,jsonb)',
    '_draw_from_bunch(uuid,integer)', '_tile_counts(uuid)'
  ];
begin
  foreach fn in array action_fns loop
    execute format('revoke all on function public.%s from public, anon, authenticated;', fn);
    execute format('grant execute on function public.%s to service_role;', fn);
  end loop;
end $$;
