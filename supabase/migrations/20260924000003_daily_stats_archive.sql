-- _archive_game_impl — add a mode = 'daily' branch: record this completion into daily_results
-- (for the live beat-percent comparison) and roll the duration into profile_stats'
-- daily_best_time_ms (least) / daily_total_time_ms (running sum), same shape and same loop
-- position as the existing solo_best_times block. Daily rooms are single-player, so the only way
-- one finishes is the sole player winning — no v_is_winner guard is needed beyond the
-- started_at/finished_at check.
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
      v_duration_ms := greatest(0, (extract(epoch from (v_room.finished_at - v_room.started_at)) * 1000)::int);
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
