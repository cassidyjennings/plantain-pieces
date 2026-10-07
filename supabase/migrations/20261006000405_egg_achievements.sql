-- Phase 4 mystery achievements + cumulative egg tracking.
--
-- profiles.eggs_found: every egg word this account has ever found. Readable only by its owner
-- (the existing profiles_select_own policy) and deliberately NOT added to profiles_public.
-- Client-reported via the end-of-game summary (p_summary -> 'eggs_found', inside the EXISTING
-- jsonb param — no signature change) and re-filtered against _easter_egg_words() here.
-- Spoofable — accepted by the spec. A guest's list dies with the 10-day guest sweep like the rest
-- of their profile.
--
-- Unlocks: egg_hunter (any egg), mind_and_hand (MIT), collector (every egg in the list — grows
-- automatically with _easter_egg_words()) in submit_game_summary; speedrun (daily, server-measured
-- duration < 60 s) in _archive_game_impl. practically_perfect is unlocked in supercali_win
-- (20261006000404).

alter table public.profiles
  add column eggs_found text[] not null default '{}';

-- ---------------------------------------------------------------------------
-- submit_game_summary — verbatim from 20260808000002 plus the [phase4] lines.
-- ---------------------------------------------------------------------------
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
  v_letter_tally jsonb;
  v_stat public.profile_stats;
  v_merged text;
  v_eggs text[];       -- [phase4]
  v_all_eggs text[];   -- [phase4]
begin
  select * into v_room from public.rooms where id = p_room_id;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;

  if v_room.mode = 'xtina' then
    update public.room_players set summary_applied = true
      where room_id = p_room_id and profile_id = p_profile;
    return jsonb_build_object('ok', true, 'longestWord', null, 'rarestWord', null, 'wordCount', 0);
  end if;

  select * into v_rp from public.room_players
    where room_id = p_room_id and profile_id = p_profile
    for update;
  if not found then raise exception 'NOT_IN_ROOM' using errcode = 'P0002'; end if;

  -- [phase4] egg words are exempt from the 2-20 pattern (SUPERCALI… is 34 letters).
  select coalesce(array_agg(upper(w)), '{}') into v_words
    from jsonb_array_elements_text(coalesce(p_summary -> 'words', '[]'::jsonb)) w
    where upper(w) ~ '^[A-Z]{2,20}$' or upper(w) = any (public._easter_egg_words());

  -- [phase4] eggs found this game: uppercased, deduped, anything not in the egg list dropped.
  select coalesce(array_agg(distinct upper(e)), '{}') into v_eggs
    from jsonb_array_elements_text(
      case when jsonb_typeof(p_summary -> 'eggs_found') = 'array'
           then p_summary -> 'eggs_found' else '[]'::jsonb end
    ) e
    where upper(e) = any (public._easter_egg_words());

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

  select coalesce(jsonb_object_agg(letter, cnt), '{}'::jsonb) into v_letter_tally
    from (
      select substr(x, 1, 1) as letter, count(*) as cnt
      from unnest(v_valid_words) x
      group by substr(x, 1, 1)
    ) g;

  if not v_rp.summary_applied then
    select * into v_stat from public.profile_stats
      where profile_id = p_profile and mode = v_room.mode;
    if not found then
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
      first_letter_counts = public._merge_letter_counts(v_stat.first_letter_counts, v_letter_tally),
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

    -- [phase4] cumulative eggs + mystery achievements. Inside the summary_applied guard, so a
    -- resubmitted summary for the same room is a no-op here too.
    if cardinality(v_eggs) > 0 then
      update public.profiles p set eggs_found = (
        select array_agg(distinct e order by e) from unnest(p.eggs_found || v_eggs) e
      )
      where p.id = p_profile
      returning p.eggs_found into v_all_eggs;

      perform public._unlock_achievement(p_profile, 'egg_hunter',
        jsonb_build_object('roomId', p_room_id, 'eggs', to_jsonb(v_eggs)));
      if 'MIT' = any (v_eggs) then
        perform public._unlock_achievement(p_profile, 'mind_and_hand', jsonb_build_object('roomId', p_room_id));
      end if;
      if public._easter_egg_words() <@ v_all_eggs then
        perform public._unlock_achievement(p_profile, 'collector', jsonb_build_object('roomId', p_room_id));
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'longestWord', v_longest,
    'rarestWord', v_rarest,
    'wordCount', v_word_count
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- _archive_game_impl: verbatim from 20261006000403 plus the [phase4] speedrun unlock.
-- ---------------------------------------------------------------------------
create or replace function public._archive_game_impl(p_room_id uuid, p_winner uuid)
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
  v_p record;
  v_peels int;
  v_dumps int;
  v_peel_streak int;
  v_first_peel_at timestamptz;
  v_first_peel_ms int;
  v_is_winner boolean;
  v_game_date date;
  v_stat public.profile_stats;
  v_prof public.profiles;
  v_new_streak int;
  v_nail_biter boolean;
  v_agg_games int;
  v_agg_peels int;
  v_bunch_key text;
  v_duration_ms int;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;

  if v_room.stats_applied then
    return jsonb_build_object('ok', true, 'roomId', p_room_id, 'alreadyApplied', true);
  end if;

  v_since := coalesce(v_room.started_at, '-infinity'::timestamptz);

  select count(*) into v_player_count
    from public.room_players where room_id = p_room_id and not is_spectator;

  select min(created_at) into v_split_at
    from public.room_events
    where room_id = p_room_id and type = 'game_started' and created_at >= v_since;

  select exists (
    select 1 from public.room_players
    where room_id = p_room_id
      and not is_spectator
      and profile_id <> p_winner
      and remaining_count = 1
  ) into v_nail_biter;

  v_game_date := coalesce(v_room.finished_at, now())::date;

  for v_p in
    select profile_id, tile_count, freeze_used  -- [phase4] freeze_used
    from public.room_players
    where room_id = p_room_id and not is_spectator
    order by seat
  loop
    -- Tiles this player drew from their own Peels ('drawn'; absent on pre-20261006000003
    -- events -> 1 per event, the old per-event count).
    select coalesce(sum(coalesce((payload ->> 'drawn')::int, 1)), 0)::int into v_peels
      from public.room_events
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

    if v_room.mode = 'multiplayer' then
      v_peel_streak := public._best_peel_streak(p_room_id, v_p.profile_id, v_since);
    else
      v_peel_streak := 0;
    end if;

    select * into v_stat from public.profile_stats
      where profile_id = v_p.profile_id and mode = v_room.mode;
    if not found then
      insert into public.profile_stats (
        profile_id, mode, games_played, games_won, total_peels, total_dumps,
        fastest_peel_ms, best_peel_streak, updated_at
      ) values (
        v_p.profile_id, v_room.mode, 1, (v_is_winner)::int, v_peels, v_dumps,
        v_first_peel_ms, v_peel_streak, now()
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
        best_peel_streak = greatest(v_stat.best_peel_streak, v_peel_streak),
        updated_at = now()
      where profile_id = v_p.profile_id and mode = v_room.mode;
    end if;
    update public.profile_stats set fastest_peel_ms = null
      where profile_id = v_p.profile_id and mode = v_room.mode and fastest_peel_ms = 2147483647;

    -- Best time per Bunch size (Timed solo wins only).
    if v_room.mode = 'solo' and v_is_winner
       and coalesce((v_room.mode_config ->> 'timed')::boolean, false)
       and v_room.started_at is not null and v_room.finished_at is not null then
      v_bunch_key := v_room.mode_config ->> 'bunchSize';
      -- [phase4] FREEZE easter egg: the 10 s the clock stood still don't count.
      v_duration_ms := greatest(0,
        (extract(epoch from (v_room.finished_at - v_room.started_at)) * 1000)::int
        - case when v_p.freeze_used then 10000 else 0 end);
      update public.profile_stats set
        solo_best_times = jsonb_set(
          coalesce(solo_best_times, '{}'::jsonb),
          array[v_bunch_key],
          to_jsonb(least(coalesce((solo_best_times ->> v_bunch_key)::int, 2147483647), v_duration_ms)),
          true)
        where profile_id = v_p.profile_id and mode = 'solo';
    end if;

    -- Daily challenge: record this completion for the live beat-percent comparison
    -- (daily_results), and roll it into this profile's personal best/average.
    if v_room.mode = 'daily'
       and v_room.started_at is not null and v_room.finished_at is not null then
      v_duration_ms := greatest(0, (extract(epoch from (v_room.finished_at - v_room.started_at)) * 1000)::int);
      insert into public.daily_results (puzzle_id, profile_id, duration_ms)
      values ((v_room.mode_config ->> 'puzzleId')::uuid, v_p.profile_id, v_duration_ms)
      on conflict (puzzle_id, profile_id) do nothing;

      update public.profile_stats set
        daily_best_time_ms = least(coalesce(daily_best_time_ms, 2147483647), v_duration_ms),
        daily_total_time_ms = daily_total_time_ms + v_duration_ms
        where profile_id = v_p.profile_id and mode = 'daily';
      update public.profile_stats set daily_best_time_ms = null
        where profile_id = v_p.profile_id and mode = 'daily' and daily_best_time_ms = 2147483647;

      -- [phase4] Mystery achievement Speedrun: server-measured, so it can't be spoofed by a
      -- client clock (FREEZE never applies to daily).
      if v_duration_ms < 60000 then
        perform public._unlock_achievement(v_p.profile_id, 'speedrun',
          jsonb_build_object('roomId', p_room_id, 'ms', v_duration_ms));
      end if;
    end if;

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

do $$
begin
  execute 'revoke all on function public._archive_game_impl(uuid,uuid) from public, anon, authenticated';
  execute 'grant execute on function public._archive_game_impl(uuid,uuid) to service_role';
end $$;
