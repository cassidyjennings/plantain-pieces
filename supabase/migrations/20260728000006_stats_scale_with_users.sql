-- Make the data footprint scale with the number of USERS, not the number of games.
--
-- Two things scaled with games, and both are fixed here.
--
-- 1. ABANDONED ROOMS (the bigger one, and a genuine leak rather than a design choice).
--    leave_room only deletes a room when the LAST player leaves, and nothing calls it when a
--    player simply closes the tab — there is no beforeunload handler, no heartbeat, no TTL and
--    no cron. So the common case leaves the room, its players (racks + grids) and every
--    room_events row behind permanently. Measured at ~16.4 KB per abandoned 4-player game,
--    roughly 3x the cost of the archive below, buying nothing at all.
--
-- 2. THE PER-GAME ARCHIVE. games + game_players kept one row per game (and per player) forever,
--    ~5.6 KB per 4-player game. Everything a player actually sees is a lifetime aggregate, which
--    profile_stats already maintains — so the per-game rows were an intermediate the UI didn't
--    need. Stats are now rolled straight into profile_stats and the per-game rows are gone.
--
-- The visible cost is the Profile -> History tab, which was per-game data by definition. That's
-- a deliberate trade: lifetime totals and records stay, the match list goes.

-- ---------------------------------------------------------------------------
-- 1. Stale-room cleanup.
-- ---------------------------------------------------------------------------

-- The lifecycle timestamp to age a room by. finished_at/started_at are always >= created_at, so
-- coalescing down to created_at gives "the last thing that happened to this room". Note a
-- rematch nulls started_at/finished_at, so a long rematch session ages from its original
-- creation — fine at a 24h threshold, since a single sitting won't come close.
create index if not exists rooms_activity_idx
  on public.rooms ((coalesce(finished_at, started_at, created_at)));

create or replace function public._sweep_stale_rooms()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  -- 24h is deliberately generous: a game runs for minutes, so anything a day old is abandoned
  -- beyond doubt. room_players and room_events cascade from this delete.
  delete from public.rooms
  where coalesce(finished_at, started_at, created_at) < now() - interval '24 hours';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Drop the per-game archive.
-- ---------------------------------------------------------------------------

drop view if exists public.my_match_history;

-- game_players FKs games, so this order matters. RLS policies, indexes and grants go with them.
drop table if exists public.game_players;
drop table if exists public.games;

-- Only ever existed to gate games/game_players RLS and the (already dropped) board view.
drop function if exists public.is_game_participant(uuid);

-- Dead scaffold from the initial schema: no code has ever read or written it, and the friends
-- feature was never built. Dropping it now rather than leaving a table nobody can explain.
drop table if exists public.friends;

-- ---------------------------------------------------------------------------
-- 3. Room-scoped idempotency for the client summary.
--
-- The end-of-game flow is two-phase: the Worker rolls up server-authoritative stats the moment
-- the game ends, then each client POSTs its own word/move summary a beat later. That second
-- phase needs a "already counted" guard so a retry can't double-count into lifetime stats.
-- That guard used to be game_players.summary_applied; with no per-game row it moves onto
-- room_players, which is exactly the right lifetime — the room is guaranteed to still exist
-- when the summary lands, and the flag disappears with it.
-- ---------------------------------------------------------------------------
alter table public.room_players
  add column if not exists summary_applied boolean not null default false;

-- Marks that this room's server-side stat rollup has run — the room-scoped replacement for the
-- old "does a games row already exist for this room_code + finished_at?" idempotency check,
-- which is gone with the table. Cleared by rematch_room so a second game in the same room rolls
-- up on its own merits. Declared here, before archive_game below reads it.
alter table public.rooms
  add column if not exists stats_applied boolean not null default false;

-- ---------------------------------------------------------------------------
-- 4. archive_game — same name (so a mid-deploy Worker still resolves it), but it no longer
--    archives anything. It rolls the server-authoritative half of the game straight into
--    profile_stats and unlocks achievements, then stops.
--
--    Achievement meta now carries roomId instead of gameId — the Results screen uses it to show
--    what was just unlocked, and gameId no longer refers to anything.
-- ---------------------------------------------------------------------------
create or replace function public.archive_game(p_room_id uuid, p_winner uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_player_count int;
  v_split_at timestamptz;
  v_since timestamptz;
  v_min_tiles int;
  v_p record;
  v_peels int;
  v_dumps int;
  v_first_peel_at timestamptz;
  v_first_peel_ms int;
  v_is_winner boolean;
  v_is_choke boolean;
  v_game_date date;
  v_stat public.profile_stats;
  v_prof public.profiles;
  v_new_streak int;
  v_nail_biter boolean;
  v_agg_games int;
  v_agg_peels int;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;

  -- Idempotency now lives on the room itself: stats_applied marks that this room's server-side
  -- rollup already happened. (It replaces the old "does a games row exist?" check, which is
  -- gone along with the table.) A rematch clears it, so game 2 in the same room rolls up again.
  if v_room.stats_applied then
    return jsonb_build_object('ok', true, 'roomId', p_room_id, 'alreadyApplied', true);
  end if;

  v_since := coalesce(v_room.started_at, '-infinity'::timestamptz);

  select count(*) into v_player_count
    from public.room_players where room_id = p_room_id and not is_spectator;

  select min(created_at) into v_split_at
    from public.room_events
    where room_id = p_room_id and type = 'game_started' and created_at >= v_since;

  select min(final_tiles) into v_min_tiles from (
    select tile_count as final_tiles from public.room_players
    where room_id = p_room_id and not is_spectator and profile_id <> p_winner
  ) s;

  select exists (
    select 1 from public.room_events e
    where e.room_id = p_room_id
      and e.type = 'plantains_rejected'
      and coalesce(e.payload ->> 'actor', '') <> p_winner::text
      and e.created_at <= v_room.finished_at
      and e.created_at >= v_room.finished_at - interval '5 seconds'
  ) into v_nail_biter;

  v_game_date := coalesce(v_room.finished_at, now())::date;

  for v_p in
    select profile_id, tile_count
    from public.room_players
    where room_id = p_room_id and not is_spectator
    order by seat
  loop
    select count(*) into v_peels from public.room_events
      where room_id = p_room_id and type = 'peel'
        and payload ->> 'actor' = v_p.profile_id::text and created_at >= v_since;
    select count(*) into v_dumps from public.room_events
      where room_id = p_room_id and type = 'dump'
        and payload ->> 'actor' = v_p.profile_id::text and created_at >= v_since;
    select min(created_at) into v_first_peel_at from public.room_events
      where room_id = p_room_id and type = 'peel'
        and payload ->> 'actor' = v_p.profile_id::text and created_at >= v_since;
    v_first_peel_ms := case when v_first_peel_at is not null and v_split_at is not null
      then (extract(epoch from (v_first_peel_at - v_split_at)) * 1000)::int end;

    v_is_winner := v_p.profile_id = p_winner;
    v_is_choke := (not v_is_winner) and v_min_tiles is not null and v_p.tile_count = v_min_tiles;

    select * into v_stat from public.profile_stats
      where profile_id = v_p.profile_id and mode = v_room.mode;
    if not found then
      insert into public.profile_stats (
        profile_id, mode, games_played, games_won, total_peels, total_dumps,
        fastest_peel_ms, choke_count, updated_at
      ) values (
        v_p.profile_id, v_room.mode, 1, (v_is_winner)::int, v_peels, v_dumps,
        v_first_peel_ms, (v_is_choke)::int, now()
      );
    else
      update public.profile_stats set
        games_played = v_stat.games_played + 1,
        games_won = v_stat.games_won + (v_is_winner)::int,
        total_peels = v_stat.total_peels + v_peels,
        total_dumps = v_stat.total_dumps + v_dumps,
        fastest_peel_ms = least(
          coalesce(v_stat.fastest_peel_ms, 2147483647),
          coalesce(v_first_peel_ms, 2147483647)),
        choke_count = v_stat.choke_count + (v_is_choke)::int,
        updated_at = now()
      where profile_id = v_p.profile_id and mode = v_room.mode;
    end if;
    update public.profile_stats set fastest_peel_ms = null
      where profile_id = v_p.profile_id and mode = v_room.mode and fastest_peel_ms = 2147483647;

    -- Account-wide play streak (NOT per-mode — playing either mode keeps the same streak alive).
    select * into v_prof from public.profiles where id = v_p.profile_id;
    if v_prof.last_played_date = v_game_date then
      v_new_streak := v_prof.current_streak;
    elsif v_prof.last_played_date = v_game_date - 1 then
      v_new_streak := v_prof.current_streak + 1;
    else
      v_new_streak := 1;
    end if;
    update public.profiles set
      current_streak = v_new_streak,
      longest_streak = greatest(v_prof.longest_streak, v_new_streak),
      last_played_date = v_game_date
      where id = v_p.profile_id;

    -- Server-authoritative achievements. meta carries roomId now; gameId no longer exists.
    if v_first_peel_ms is not null and v_first_peel_ms <= 60000 then
      perform public._unlock_achievement(v_p.profile_id, 'speed_peeler', jsonb_build_object('roomId', p_room_id, 'ms', v_first_peel_ms));
    end if;
    if v_is_winner and v_p.tile_count >= 100 then
      perform public._unlock_achievement(v_p.profile_id, 'marathon_mind', jsonb_build_object('roomId', p_room_id, 'tiles', v_p.tile_count));
    end if;
    if v_is_winner and v_dumps = 0 then
      perform public._unlock_achievement(v_p.profile_id, 'no_dumps_given', jsonb_build_object('roomId', p_room_id));
    end if;
    if v_player_count >= 8 then
      perform public._unlock_achievement(v_p.profile_id, 'full_house', jsonb_build_object('roomId', p_room_id));
    end if;
    if v_is_winner and v_nail_biter then
      perform public._unlock_achievement(v_p.profile_id, 'nail_biter', jsonb_build_object('roomId', p_room_id));
    end if;
    -- Lifetime-threshold achievements are mode-agnostic — sum across the profile's mode rows.
    select coalesce(sum(games_played), 0), coalesce(sum(total_peels), 0)
      into v_agg_games, v_agg_peels
      from public.profile_stats where profile_id = v_p.profile_id;
    if v_agg_games >= 100 then
      perform public._unlock_achievement(v_p.profile_id, 'century_club', jsonb_build_object('games', v_agg_games));
    end if;
    if v_agg_peels >= 1000 then
      perform public._unlock_achievement(v_p.profile_id, 'peel_machine', jsonb_build_object('peels', v_agg_peels));
    end if;
  end loop;

  update public.rooms set stats_applied = true where id = p_room_id;

  return jsonb_build_object('ok', true, 'roomId', p_room_id, 'alreadyApplied', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. submit_game_summary — re-keyed from game to ROOM.
--
-- Dropped and recreated rather than replaced: create-or-replace cannot rename an input
-- parameter, and Supabase .rpc() calls pass arguments by name.
-- ---------------------------------------------------------------------------
drop function if exists public.submit_game_summary(uuid, uuid, jsonb);

create or replace function public.submit_game_summary(
  p_room_id uuid, p_profile uuid, p_summary jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_rp public.room_players;
  v_words text[];
  v_invalid text[];
  v_valid_words text[];
  v_word_count int;
  v_total_len bigint;
  v_longest text;
  v_longest_len int;
  v_rarest text;
  v_rarest_score int;
  v_new_letters text;
  v_stat public.profile_stats;
  v_merged text;
begin
  select * into v_room from public.rooms where id = p_room_id;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;

  select * into v_rp from public.room_players
    where room_id = p_room_id and profile_id = p_profile
    for update;
  if not found then raise exception 'NOT_IN_ROOM' using errcode = 'P0002'; end if;

  -- Extract WORD_PATTERN-shaped words (defense-in-depth; Worker already validated).
  select coalesce(array_agg(upper(w)), '{}') into v_words
    from jsonb_array_elements_text(coalesce(p_summary -> 'words', '[]'::jsonb)) w
    where upper(w) ~ '^[A-Z]{2,20}$';

  -- Dictionary-filter before anything is counted: a losing player's final grid is whatever
  -- half-built state they were in, so without this a fragment like REDUND lands in their
  -- lifetime records as a real word. The room's own config is the right dictionary and it's
  -- guaranteed to still exist here (the summary arrives while the room is alive).
  v_invalid := public._find_invalid_words_cfg(coalesce(v_room.dictionary_config, '{}'::jsonb), v_words);
  select coalesce(array_agg(w), '{}') into v_valid_words
    from unnest(v_words) w
    where not (w = any(v_invalid));

  v_word_count := coalesce(array_length(v_valid_words, 1), 0);
  select coalesce(sum(char_length(x)), 0) into v_total_len from unnest(v_valid_words) x;

  select x into v_longest from unnest(v_valid_words) x order by char_length(x) desc, x limit 1;
  v_longest_len := coalesce(char_length(v_longest), 0);

  select x, public.word_rarity(x) into v_rarest, v_rarest_score
    from unnest(v_valid_words) x order by public.word_rarity(x) desc, x limit 1;
  v_rarest_score := coalesce(v_rarest_score, 0);

  select string_agg(distinct substr(x, 1, 1), '' order by substr(x, 1, 1))
    into v_new_letters from unnest(v_valid_words) x;
  v_new_letters := coalesce(v_new_letters, '');

  -- Roll into lifetime word stats exactly once per player per game.
  if not v_rp.summary_applied then
    select * into v_stat from public.profile_stats
      where profile_id = p_profile and mode = v_room.mode;
    if not found then
      -- archive_game normally creates this row first, but a client summary could in principle
      -- arrive before it; create the row rather than silently dropping the words.
      insert into public.profile_stats (profile_id, mode, updated_at)
      values (p_profile, v_room.mode, now());
      select * into v_stat from public.profile_stats
        where profile_id = p_profile and mode = v_room.mode;
    end if;

    select string_agg(c, '' order by c) into v_merged from (
      select distinct unnest(string_to_array(coalesce(v_stat.first_letters, '') || v_new_letters, null)) as c
    ) s where c ~ '^[A-Z]$';

    update public.profile_stats set
      total_words = v_stat.total_words + v_word_count,
      total_word_length = v_stat.total_word_length + v_total_len,
      longest_word = case when v_longest_len > v_stat.longest_word_length then v_longest else v_stat.longest_word end,
      longest_word_length = greatest(v_stat.longest_word_length, v_longest_len),
      rarest_word = case when v_rarest_score > v_stat.rarest_word_score then v_rarest else v_stat.rarest_word end,
      rarest_word_score = greatest(v_stat.rarest_word_score, v_rarest_score),
      first_letters = coalesce(v_merged, v_stat.first_letters),
      updated_at = now()
    where profile_id = p_profile and mode = v_room.mode;

    update public.room_players set summary_applied = true where id = v_rp.id;

    if exists (select 1 from unnest(v_valid_words) x where public.word_rarity(x) >= 30) then
      perform public._unlock_achievement(p_profile, 'word_nerd',
        jsonb_build_object('roomId', p_room_id, 'word', v_rarest, 'score', v_rarest_score));
    end if;
    if coalesce(char_length(v_merged), 0) >= 26 then
      perform public._unlock_achievement(p_profile, 'alphabet_soup', jsonb_build_object('roomId', p_room_id));
    end if;
  end if;

  -- Returned so the Results screen can show this game's numbers without any per-game storage.
  return jsonb_build_object(
    'ok', true,
    'longestWord', v_longest,
    'rarestWord', v_rarest,
    'wordCount', v_word_count
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Wire the sweep into room creation, and reset the rollup flag on rematch.
-- ---------------------------------------------------------------------------

create or replace function public.rematch_room(p_room_id uuid, p_profile uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_is_member boolean;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;

  select exists (
    select 1 from public.room_players where room_id = p_room_id and profile_id = p_profile
  ) into v_is_member;
  if not v_is_member then raise exception 'NOT_IN_ROOM' using errcode = 'P0002'; end if;

  if v_room.mode <> 'multiplayer' then
    raise exception 'NOT_MULTIPLAYER' using errcode = 'P0001';
  end if;

  if v_room.status = 'lobby' then
    return jsonb_build_object('roomId', v_room.id, 'code', v_room.code, 'alreadyReset', true);
  end if;
  if v_room.status <> 'finished' then
    raise exception 'GAME_NOT_FINISHED' using errcode = 'P0001';
  end if;

  update public.rooms set
    status = 'lobby',
    winner_id = null,
    started_at = null,
    finished_at = null,
    bunch = public._fresh_bunch(),
    bunch_count = 144,
    stats_applied = false
  where id = p_room_id;

  update public.room_players set
    rack = '[]'::jsonb,
    grid_state = '{}'::jsonb,
    tile_count = 0,
    is_ready = false,
    remaining_count = null,
    summary_applied = false
  where room_id = p_room_id;

  delete from public.room_events where room_id = p_room_id;

  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'rematch',
          jsonb_build_object('actor', p_profile, 'roomId', p_room_id, 'code', v_room.code));

  return jsonb_build_object('roomId', v_room.id, 'code', v_room.code, 'alreadyReset', false);
end;
$$;

-- create_room / create_solo_room sweep stale rooms opportunistically. This is the cheapest
-- reliable trigger available without pg_cron: every new game pays one indexed delete, which
-- bounds the room tables by ACTIVE play in the last 24h rather than by games ever played.
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
  perform public._sweep_stale_rooms();

  v_config := coalesce(p_config,
    '{"minLength":2,"maxLength":null,"baseEnabled":true,"excludedTopics":[],"customSetIds":[]}'::jsonb);

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

create or replace function public.create_solo_room(
  p_host uuid, p_display_name text, p_dictionary_config jsonb, p_bunch_size int, p_timed boolean
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
begin
  perform public._sweep_stale_rooms();

  if p_bunch_size < 40 or p_bunch_size > 144 then
    raise exception 'INVALID_BUNCH_SIZE' using errcode = 'P0001';
  end if;

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
    'solo', jsonb_build_object('bunchSize', p_bunch_size, 'timed', p_timed),
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
                            'bunchSize', p_bunch_size, 'timed', p_timed);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Lock the new/changed functions down to the Worker, matching every other action RPC.
-- ---------------------------------------------------------------------------
do $$
begin
  execute 'revoke all on function public._sweep_stale_rooms() from public, anon, authenticated';
  execute 'grant execute on function public._sweep_stale_rooms() to service_role';
  execute 'revoke all on function public.submit_game_summary(uuid,uuid,jsonb) from public, anon, authenticated';
  execute 'grant execute on function public.submit_game_summary(uuid,uuid,jsonb) to service_role';
end $$;
