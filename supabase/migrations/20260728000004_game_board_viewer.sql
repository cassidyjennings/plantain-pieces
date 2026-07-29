-- End-of-game board viewer: let the players in a finished game look at each other's final
-- boards and the words they played.
--
-- Note this deliberately opens a door the rest of the game keeps firmly shut: DURING play,
-- opponent grids are never sent (see CLAUDE.md — only tile counts and public status are
-- exposed, and rack/grid_state are RLS-private). That rule exists so nobody can read an
-- opponent's board mid-game. Once the game is over there's nothing left to protect and seeing
-- what everyone built is the whole point, so this exposes final boards ONLY:
--   * through a separate view over the archived game_players rows, never over live room_players
--   * gated by is_game_participant(), so only people who actually played that game can read it
-- Live-game privacy is untouched.

-- ---------------------------------------------------------------------------
-- final_grid: the player's board as it stood when the game ended.
-- ---------------------------------------------------------------------------
alter table public.game_players
  add column final_grid jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- archive_game — same as 20260728000001, plus seeding final_grid from the player's last
-- persisted grid_state. That snapshot is only written on Peel/Plantains, so for a non-winner
-- it can be somewhat behind their true final board; the client's own end-of-game summary
-- (submit_game_summary below) overwrites it with the real thing a beat later. This seed is the
-- fallback for a player whose client never submits at all — closed the tab, lost connection.
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

  -- Lower bound for every room_events aggregate below: a rematch reuses the room, and although
  -- rematch_room clears the log, this guard means a future path that reuses a room WITHOUT
  -- clearing it can't silently double-count a player's peels into their lifetime stats.
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
    select profile_id, display_name, seat, tile_count, grid_state
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
      final_tile_count, peels, dumps, first_peel_ms, opponents, mode, final_grid
    ) values (
      v_game_id, v_p.profile_id, v_p.seat, v_p.display_name, v_is_winner,
      v_p.tile_count, v_peels, v_dumps, v_first_peel_ms, v_opponents, v_room.mode,
      coalesce(v_p.grid_state, '{}'::jsonb)
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
-- submit_game_summary — same as 20260728000002, plus storing the client's real final grid.
-- Only overwrites when the client actually sent a non-empty grid, so a client on an older
-- build (no `grid` field) leaves archive_game's grid_state seed intact rather than blanking it.
-- ---------------------------------------------------------------------------
create or replace function public.submit_game_summary(
  p_game_id uuid, p_profile uuid, p_summary jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gp public.game_players;
  v_cfg jsonb;
  v_words text[];
  v_invalid text[];
  v_valid_words text[];
  v_word_count int;
  v_total_len bigint;
  v_longest text;
  v_longest_len int;
  v_rarest text;
  v_rarest_score int;
  v_placed int;
  v_grid jsonb;
  v_new_letters text;
  v_stat public.profile_stats;
  v_merged text;
begin
  select * into v_gp from public.game_players
    where game_id = p_game_id and profile_id = p_profile;
  if not found then raise exception 'NOT_A_PARTICIPANT' using errcode = 'P0002'; end if;

  -- Extract WORD_PATTERN-shaped words (defense-in-depth; Worker already validated).
  select coalesce(array_agg(upper(w)), '{}') into v_words
    from jsonb_array_elements_text(coalesce(p_summary -> 'words', '[]'::jsonb)) w
    where upper(w) ~ '^[A-Z]{2,20}$';

  -- Dictionary-filter: only words that were actually valid in THIS game count for anything
  -- below. games.dictionary_config is a durable snapshot taken at archive time, so this is
  -- correct even after the room itself has been torn down or rematched.
  select dictionary_config into v_cfg from public.games where id = v_gp.game_id;
  v_invalid := public._find_invalid_words_cfg(coalesce(v_cfg, '{}'::jsonb), v_words);
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

  v_placed := nullif(p_summary ->> 'placedCount', '')::int;
  -- Clamp an absurd placed count to the server-known tile total.
  if v_placed is not null and v_placed > v_gp.final_tile_count then
    v_placed := v_gp.final_tile_count;
  end if;

  -- The board itself, for the end-of-game viewer. Only a jsonb OBJECT is accepted; anything
  -- else (array, scalar, null, or a missing field on an older client) leaves the existing
  -- archive_game seed alone.
  v_grid := p_summary -> 'grid';
  if v_grid is null or jsonb_typeof(v_grid) <> 'object' or v_grid = '{}'::jsonb then
    v_grid := null;
  end if;

  select string_agg(distinct substr(x, 1, 1), '' order by substr(x, 1, 1))
    into v_new_letters from unnest(v_valid_words) x;
  v_new_letters := coalesce(v_new_letters, '');

  -- Always refresh the descriptive columns. words_played stores the FILTERED list -- it's a
  -- display field (match history + the board viewer's word list), and showing an invalid
  -- fragment there is the same bug as the Results tile.
  update public.game_players set
    final_placed_count = v_placed,
    words_played = to_jsonb(coalesce(v_valid_words, '{}'::text[])),
    longest_word = v_longest,
    rarest_word = v_rarest,
    rarest_word_score = v_rarest_score,
    final_grid = coalesce(v_grid, final_grid),
    move_stats = coalesce(p_summary -> 'moveStats', '{}'::jsonb)
  where id = v_gp.id;

  -- Roll into lifetime word stats only once per game_player.
  if not v_gp.summary_applied then
    select * into v_stat from public.profile_stats
      where profile_id = p_profile and mode = v_gp.mode;
    -- profile_stats row is guaranteed to exist for (p_profile, v_gp.mode) — archive_game created it.
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
    where profile_id = p_profile and mode = v_gp.mode;

    update public.game_players set summary_applied = true where id = v_gp.id;

    -- Word-based achievements.
    if exists (select 1 from unnest(v_valid_words) x where public.word_rarity(x) >= 30) then
      perform public._unlock_achievement(p_profile, 'word_nerd',
        jsonb_build_object('gameId', p_game_id, 'word', v_rarest, 'score', v_rarest_score));
    end if;
    if coalesce(char_length(v_merged), 0) >= 26 then
      perform public._unlock_achievement(p_profile, 'alphabet_soup', jsonb_build_object('gameId', p_game_id));
    end if;
  end if;

  return jsonb_build_object('ok', true, 'longestWord', v_longest, 'rarestWord', v_rarest);
end;
$$;

-- ---------------------------------------------------------------------------
-- game_boards_public — every participant's final board for a game you played in.
--
-- security_invoker = false (owner-bypass) + an is_game_participant() gate is the same shape as
-- my_match_history: the view itself does the authorization, so game_players' own
-- "self rows only" RLS policy doesn't need widening (which would have leaked these columns
-- into every other game_players read path too).
--
-- avatar_config comes from the live profiles row rather than a per-game snapshot: game_players
-- has no avatar column, and showing a player's CURRENT plantain in the nav is a fine
-- approximation — worst case someone restyled their avatar after the game.
-- ---------------------------------------------------------------------------
create or replace view public.game_boards_public
with (security_invoker = false) as
  select gp.game_id,
         gp.profile_id,
         gp.display_name,
         gp.seat,
         gp.is_winner,
         gp.final_tile_count,
         gp.final_placed_count,
         gp.final_grid,
         gp.longest_word,
         gp.words_played,
         coalesce(p.avatar_config, '{}'::jsonb) as avatar_config
  from public.game_players gp
  left join public.profiles p on p.id = gp.profile_id
  where public.is_game_participant(gp.game_id);

-- RLS is necessary but NOT sufficient on this CLI — the base GRANT is required too, or the
-- client silently reads nothing (see 20260710000001_authenticated_grants.sql).
grant select on public.game_boards_public to authenticated;
