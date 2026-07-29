-- Rematch: reuse the SAME room (and therefore the same code) instead of minting a new one.
--
-- The old client-side "rematch" called create_room, so every player who clicked it got their
-- own brand-new room with a fresh random code and sat there alone — a rematch could never
-- actually happen. The room already survives the game (finish_game only flips status to
-- 'finished'; the row, its code and every room_players row are still there), so the fix is to
-- reset that room back to a lobby in place.

-- ---------------------------------------------------------------------------
-- rematch_room — reset a finished multiplayer room to a fresh lobby, in place.
-- Same room id, same code, same players, cleared racks/grids/ready flags, full Bunch.
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

  -- Any member may call it, not just the host: the host may well have left mid-game (leave_room
  -- already migrated the host seat), and whoever is still on the results screen should be able
  -- to restart. Membership is the gate.
  select exists (
    select 1 from public.room_players where room_id = p_room_id and profile_id = p_profile
  ) into v_is_member;
  if not v_is_member then raise exception 'NOT_IN_ROOM' using errcode = 'P0002'; end if;

  -- Solo keeps its own path: create_solo_room seeds a Bunch scaled from mode_config and deals
  -- the opening hand atomically, which is a different reset than "back to a lobby".
  if v_room.mode <> 'multiplayer' then
    raise exception 'NOT_MULTIPLAYER' using errcode = 'P0001';
  end if;

  -- Idempotent: whoever clicked first already reset it. Two players clicking at the same instant
  -- must BOTH end up in the same lobby, so a room that's already back in 'lobby' is a success,
  -- not a conflict. This is what makes the concurrent case safe.
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
    bunch_count = 144
  where id = p_room_id;

  -- Spectators are reset too (their racks are already empty); is_ready must clear or the Lobby
  -- would show everyone pre-readied from the previous game.
  update public.room_players set
    rack = '[]'::jsonb,
    grid_state = '{}'::jsonb,
    tile_count = 0,
    is_ready = false
  where room_id = p_room_id;

  -- room_events is the fan-out/replay log for ONE game. Carrying the previous game's rows into
  -- the next one would corrupt archive_game, which derives each player's peel/dump counts and
  -- the Split timestamp by querying this table filtered only on room_id/type/actor — game 2
  -- would archive game 1's peels on top of its own, inflating profile_stats.total_peels and
  -- skewing first_peel_ms and the speed_peeler achievement. The durable record of the finished
  -- game already lives in games/game_players, so clearing the log here loses nothing.
  -- (archive_game also gets a started_at guard below, as defense in depth.)
  delete from public.room_events where room_id = p_room_id;

  -- Inserted AFTER the delete so it survives: this is what pulls every other client off the
  -- results screen and into the lobby.
  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'rematch',
          jsonb_build_object('actor', p_profile, 'roomId', p_room_id, 'code', v_room.code));

  return jsonb_build_object('roomId', v_room.id, 'code', v_room.code, 'alreadyReset', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- archive_game — same as 20260721000002, with one change: the three room_events aggregates
-- (peels, dumps, first-peel time) are now bounded to events at or after the room's started_at.
--
-- Reusing a room for a rematch means room_events can, in principle, contain rows from an
-- earlier game in the same room. rematch_room clears them, so this guard should never actually
-- exclude anything — it exists so that a future code path which reuses a room WITHOUT clearing
-- the log can't silently double-count a player's peels into their lifetime stats.
--
-- Safe on the equality edge: start_game sets started_at = now() and inserts the game_started
-- event in the SAME transaction, and now() is the transaction timestamp, so the event's
-- created_at is exactly equal to started_at — hence >=, not >.
-- ---------------------------------------------------------------------------
create or replace function public.archive_game(p_room_id uuid, p_winner uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_game_id uuid;
  v_existing uuid;
  v_player_count int;
  v_spectator_count int;
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
  v_opponents jsonb;
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

  -- Idempotency: if this finished game was already archived, return it. Still correct with
  -- rematches reusing a room code, because each game has its own finished_at.
  select id into v_existing from public.games
    where room_code = v_room.code and finished_at = v_room.finished_at limit 1;
  if v_existing is not null then
    return jsonb_build_object('gameId', v_existing, 'alreadyArchived', true);
  end if;

  -- Lower bound for every room_events aggregate below (see the header note).
  v_since := coalesce(v_room.started_at, '-infinity'::timestamptz);

  select count(*) filter (where not is_spectator),
         count(*) filter (where is_spectator)
    into v_player_count, v_spectator_count
    from public.room_players where room_id = p_room_id;

  select min(created_at) into v_split_at
    from public.room_events
    where room_id = p_room_id and type = 'game_started' and created_at >= v_since;

  select min(final_tiles) into v_min_tiles from (
    select tile_count as final_tiles from public.room_players
    where room_id = p_room_id and not is_spectator and profile_id <> p_winner
  ) s;

  insert into public.games (
    room_code, winner_id, player_count, spectator_count,
    dictionary_config, started_at, finished_at, duration_ms, mode, mode_config
  ) values (
    v_room.code, p_winner, v_player_count, v_spectator_count,
    v_room.dictionary_config, v_room.started_at, v_room.finished_at,
    case when v_room.started_at is not null and v_room.finished_at is not null
      then (extract(epoch from (v_room.finished_at - v_room.started_at)) * 1000)::int end,
    v_room.mode, v_room.mode_config
  ) returning id into v_game_id;

  v_game_date := coalesce(v_room.finished_at, now())::date;

  -- Nail Biter signal: an opponent's Plantains attempt was rejected within 5s BEFORE
  -- the win (a real near-miss the winner beat), measured against the room's finished_at
  -- (the win time). Naturally never true in solo (no opponents to reject a Plantains call).
  select exists (
    select 1 from public.room_events e
    where e.room_id = p_room_id
      and e.type = 'plantains_rejected'
      and coalesce(e.payload ->> 'actor', '') <> p_winner::text
      and e.created_at <= v_room.finished_at
      and e.created_at >= v_room.finished_at - interval '5 seconds'
  ) into v_nail_biter;

  for v_p in
    select profile_id, display_name, seat, tile_count
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
    -- Choke proxy: a non-winner tied for the fewest total tiles (closest to out) but
    -- didn't win. Naturally never true in solo (no non-winners exist).
    v_is_choke := (not v_is_winner) and v_min_tiles is not null and v_p.tile_count = v_min_tiles;

    select coalesce(jsonb_agg(jsonb_build_object(
             'profileId', o.profile_id, 'displayName', o.display_name,
             'seat', o.seat, 'isWinner', o.profile_id = p_winner)), '[]'::jsonb)
      into v_opponents
      from public.room_players o
      where o.room_id = p_room_id and not o.is_spectator and o.profile_id <> v_p.profile_id;

    insert into public.game_players (
      game_id, profile_id, seat, display_name, is_winner,
      final_tile_count, peels, dumps, first_peel_ms, opponents, mode
    ) values (
      v_game_id, v_p.profile_id, v_p.seat, v_p.display_name, v_is_winner,
      v_p.tile_count, v_peels, v_dumps, v_first_peel_ms, v_opponents, v_room.mode
    );

    -- Lifetime rollup (server-authoritative parts), keyed by (profile_id, mode).
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
    -- Normalize the sentinel back to null if no peel ever happened for anyone.
    update public.profile_stats set fastest_peel_ms = null
      where profile_id = v_p.profile_id and mode = v_room.mode and fastest_peel_ms = 2147483647;

    -- Account-wide play streak (NOT per-mode — playing either mode keeps the same streak alive).
    select * into v_prof from public.profiles where id = v_p.profile_id;
    if v_prof.last_played_date = v_game_date then
      v_new_streak := v_prof.current_streak;               -- already played today
    elsif v_prof.last_played_date = v_game_date - 1 then
      v_new_streak := v_prof.current_streak + 1;           -- consecutive day
    else
      v_new_streak := 1;                                   -- gap or first game ever
    end if;
    update public.profiles set
      current_streak = v_new_streak,
      longest_streak = greatest(v_prof.longest_streak, v_new_streak),
      last_played_date = v_game_date
      where id = v_p.profile_id;

    -- Server-authoritative achievements.
    if v_first_peel_ms is not null and v_first_peel_ms <= 60000 then
      perform public._unlock_achievement(v_p.profile_id, 'speed_peeler', jsonb_build_object('gameId', v_game_id, 'ms', v_first_peel_ms));
    end if;
    if v_is_winner and v_p.tile_count >= 100 then
      perform public._unlock_achievement(v_p.profile_id, 'marathon_mind', jsonb_build_object('gameId', v_game_id, 'tiles', v_p.tile_count));
    end if;
    if v_is_winner and v_dumps = 0 then
      perform public._unlock_achievement(v_p.profile_id, 'no_dumps_given', jsonb_build_object('gameId', v_game_id));
    end if;
    if v_player_count >= 8 then
      perform public._unlock_achievement(v_p.profile_id, 'full_house', jsonb_build_object('gameId', v_game_id));
    end if;
    if v_is_winner and v_nail_biter then
      perform public._unlock_achievement(v_p.profile_id, 'nail_biter', jsonb_build_object('gameId', v_game_id));
    end if;
    -- Lifetime-threshold achievements (Century Club / Peel Machine) are mode-agnostic — check the
    -- SUM across all of this profile's mode rows, not the single just-updated mode row.
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

  return jsonb_build_object('gameId', v_game_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock rematch_room down to the Worker (service_role), same pattern as every other action RPC.
-- (archive_game keeps its existing grants — same signature, create-or-replace preserves them.)
-- ---------------------------------------------------------------------------
do $$
begin
  execute 'revoke all on function public.rematch_room(uuid,uuid) from public, anon, authenticated';
  execute 'grant execute on function public.rematch_room(uuid,uuid) to service_role';
end $$;
