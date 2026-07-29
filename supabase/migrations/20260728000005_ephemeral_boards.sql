-- Final boards become EPHEMERAL: buffered for as long as the room lives, gone with it.
--
-- 20260728000004 archived each player's final board into game_players.final_grid, which
-- outlives the room forever. But nothing can ever read it once the room is gone: the Results
-- screen renders off rooms_public, so when leave_room tears the room down Results stops
-- resolving, and with it the only navigation path into the board viewer. History deliberately
-- doesn't link to boards either. So the column was storing data no user could ever reach again
-- — pure cost, no benefit, and player data retained for no reason.
--
-- Boards now live on room_players.grid_state, which already exists and already cascades away
-- with the room. The viewer's window is exactly the window it was ever usable in: after the
-- game, while people are still in the room.

-- The view goes first — it depends on the column being dropped below.
drop view if exists public.game_boards_public;

alter table public.game_players
  drop column if exists final_grid;

-- ---------------------------------------------------------------------------
-- room_boards_public — every player's final board for a FINISHED room you're a member of.
--
-- `r.status = 'finished'` is load-bearing, not decoration. Without it this view would expose
-- opponents' live grid_state mid-game, which is the single privacy rule the whole architecture
-- is built around (CLAUDE.md: "Opponent grids are never sent"). The gate is what makes reading
-- another player's board safe: it can only ever return rows for a game that is already over.
--
-- Spectators are excluded — they have no board.
-- ---------------------------------------------------------------------------
create or replace view public.room_boards_public
with (security_invoker = false) as
  select rp.room_id,
         rp.profile_id,
         rp.display_name,
         rp.seat,
         (r.winner_id is not null and r.winner_id = rp.profile_id) as is_winner,
         rp.tile_count,
         rp.grid_state,
         rp.avatar_config
  from public.room_players rp
  join public.rooms r on r.id = rp.room_id
  where public.is_room_member(rp.room_id)
    and r.status = 'finished'
    and not rp.is_spectator;

-- RLS is necessary but NOT sufficient on this CLI — the base GRANT is required too, or the
-- client silently reads nothing (see 20260710000001_authenticated_grants.sql).
grant select on public.room_boards_public to authenticated;

-- ---------------------------------------------------------------------------
-- archive_game — reverted to the 20260728000001 body (no final_grid). Everything else about it,
-- including the created_at >= started_at guards that keep a rematched room from double-counting
-- a previous game's peels, is carried forward unchanged.
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

  select id into v_existing from public.games
    where room_code = v_room.code and finished_at = v_room.finished_at limit 1;
  if v_existing is not null then
    return jsonb_build_object('gameId', v_existing, 'alreadyArchived', true);
  end if;

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
-- submit_game_summary — reverted to the 20260728000002 body (no grid handling). The
-- dictionary-filtering of words, which fixed the "REDUND as longest word" bug, is unchanged.
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
  v_new_letters text;
  v_stat public.profile_stats;
  v_merged text;
begin
  select * into v_gp from public.game_players
    where game_id = p_game_id and profile_id = p_profile;
  if not found then raise exception 'NOT_A_PARTICIPANT' using errcode = 'P0002'; end if;

  select coalesce(array_agg(upper(w)), '{}') into v_words
    from jsonb_array_elements_text(coalesce(p_summary -> 'words', '[]'::jsonb)) w
    where upper(w) ~ '^[A-Z]{2,20}$';

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
  if v_placed is not null and v_placed > v_gp.final_tile_count then
    v_placed := v_gp.final_tile_count;
  end if;

  select string_agg(distinct substr(x, 1, 1), '' order by substr(x, 1, 1))
    into v_new_letters from unnest(v_valid_words) x;
  v_new_letters := coalesce(v_new_letters, '');

  update public.game_players set
    final_placed_count = v_placed,
    words_played = to_jsonb(coalesce(v_valid_words, '{}'::text[])),
    longest_word = v_longest,
    rarest_word = v_rarest,
    rarest_word_score = v_rarest_score,
    move_stats = coalesce(p_summary -> 'moveStats', '{}'::jsonb)
  where id = v_gp.id;

  if not v_gp.summary_applied then
    select * into v_stat from public.profile_stats
      where profile_id = p_profile and mode = v_gp.mode;
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
