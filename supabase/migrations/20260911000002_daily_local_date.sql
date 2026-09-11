-- Roll the daily puzzle over at the player's local midnight.
--
-- The puzzle day was the UTC date everywhere (current_date here, toISOString() in the Worker and
-- client), so it rolled over at 00:00 UTC: 8pm on the US east coast, not midnight. The client now
-- sends the player's own local date. Every real timezone's local date is within one day of the
-- UTC date, so anything outside that window is refused rather than letting a player open a
-- puzzle days early. NULL keeps the old UTC behavior for callers that don't send a date.
--
-- Dropped and recreated rather than overloaded: a two-argument call would be ambiguous between a
-- 2-arg function and a 3-arg one with a default. The default also lets the Worker that's still
-- deployed when this runs keep calling with two named arguments until the new one replaces it.
drop function if exists public.create_daily_room(uuid, text);

create or replace function public.create_daily_room(
  p_host         uuid,
  p_display_name text,
  p_date         date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_utc_today  date := (now() at time zone 'utc')::date;
  v_date       date;
  v_puzzle     record;
  v_code       text;
  v_room_id    uuid;
  v_bunch      jsonb;
  v_bunch_size int;
  v_deal       int;
  v_tiles      text[];
begin
  v_date := coalesce(p_date, v_utc_today);
  if v_date not between v_utc_today - 1 and v_utc_today + 1 then
    raise exception 'INVALID_DAILY_DATE' using errcode = 'P0001';
  end if;

  select id, letter_multiset, dictionary_config, scheduled_date
  into   v_puzzle
  from   public.daily_puzzles
  where  status         = 'scheduled'
    and  scheduled_date = v_date
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
  execute 'revoke all on function public.create_daily_room(uuid,text,date) from public, anon, authenticated';
  execute 'grant execute on function public.create_daily_room(uuid,text,date) to service_role';
end;
$$;
