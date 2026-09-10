-- Add 'daily' to rooms.mode and create the create_daily_room RPC.

-- rooms.mode gains a 'daily' value. Drop and rebuild the check constraint, same
-- pattern as the xtina migration (20260805000001).
alter table public.rooms drop constraint if exists rooms_mode_check;
alter table public.rooms
  add constraint rooms_mode_check
  check (mode in ('multiplayer', 'solo', 'xtina', 'daily'));

-- ---------------------------------------------------------------------------
-- _multiset_to_bunch: convert a flat "AAABBC..." letter string to
-- {"A":2,"B":2,"C":1} JSONB that _draw_from_bunch understands.
-- ---------------------------------------------------------------------------
create or replace function public._multiset_to_bunch(p_multiset text)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_object_agg(letter, cnt)
  from (
    select substr(p_multiset, n, 1) as letter,
           count(*)                  as cnt
    from   generate_series(1, length(p_multiset)) as n
    group  by letter
  ) t;
$$;

-- ---------------------------------------------------------------------------
-- create_daily_room: find today's scheduled puzzle, seed a room with its exact
-- letter set, deal the opening hand, and mark it active. The client navigates
-- straight into the game — same as solo mode, no Lobby step.
--
-- mode_config shape: { "puzzleId": "<uuid>", "scheduledDate": "YYYY-MM-DD" }
-- ---------------------------------------------------------------------------
create or replace function public.create_daily_room(
  p_host         uuid,
  p_display_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_puzzle     record;
  v_code       text;
  v_room_id    uuid;
  v_bunch      jsonb;
  v_bunch_size int;
  v_deal       int;
  v_tiles      text[];
begin
  select id, letter_multiset, dictionary_config, scheduled_date
  into   v_puzzle
  from   public.daily_puzzles
  where  status         = 'scheduled'
    and  scheduled_date = current_date
    and  language       = 'en'
  limit  1;

  if not found then
    raise exception 'NO_DAILY_PUZZLE' using errcode = 'P0001';
  end if;

  v_bunch      := public._multiset_to_bunch(v_puzzle.letter_multiset);
  v_bunch_size := length(v_puzzle.letter_multiset);

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
    v_code, p_host, v_puzzle.dictionary_config, v_bunch, v_bunch_size,
    'daily',
    jsonb_build_object('puzzleId', v_puzzle.id,
                       'scheduledDate', v_puzzle.scheduled_date::text),
    'active', now()
  ) returning id into v_room_id;

  insert into public.room_players (room_id, profile_id, display_name, seat)
  values (v_room_id, p_host, p_display_name, 0);

  insert into public.room_events (room_id, type, payload)
  values (v_room_id, 'player_joined',
          jsonb_build_object('profileId', p_host, 'displayName', p_display_name, 'seat', 0));

  v_deal  := public._initial_deal(1);
  v_tiles := public._draw_from_bunch(v_room_id, v_deal);

  update public.room_players
     set rack       = to_jsonb(v_tiles),
         tile_count = array_length(v_tiles, 1),
         grid_state = '{}'::jsonb
   where room_id = v_room_id and profile_id = p_host;

  insert into public.room_events (room_id, type, payload)
  values (v_room_id, 'game_started',
          jsonb_build_object(
            'dealt',      v_deal,
            'bunchCount', (select bunch_count from public.rooms where id = v_room_id),
            'tileCounts', public._tile_counts(v_room_id)
          ));

  return jsonb_build_object(
    'roomId',        v_room_id,
    'code',          v_code,
    'seat',          0,
    'puzzleId',      v_puzzle.id,
    'scheduledDate', v_puzzle.scheduled_date::text
  );
end;
$$;

do $$
begin
  execute 'revoke all on function public._multiset_to_bunch(text) from public, anon, authenticated';
  execute 'grant execute on function public._multiset_to_bunch(text) to service_role';
  execute 'revoke all on function public.create_daily_room(uuid,text) from public, anon, authenticated';
  execute 'grant execute on function public.create_daily_room(uuid,text) to service_role';
end;
$$;
