-- Replace choke rate / alphabet letters with best peel streak / favorite starting letter on the
-- Stats tab. See docs/superpowers/specs/2026-08-08-stats-peel-streak-favorite-letter-design.md.

-- ---------------------------------------------------------------------------
-- 1. Schema: drop choke_count (nothing reads it once the tile is gone — no achievement depends
--    on it), add the two new lifetime fields.
-- ---------------------------------------------------------------------------
alter table public.profile_stats
  drop column if exists choke_count,
  add column if not exists best_peel_streak int not null default 0,
  add column if not exists first_letter_counts jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 2. _merge_letter_counts — sums two per-letter frequency maps key-wise. Pure: no table access,
--    so it's directly testable with plain SELECTs.
-- ---------------------------------------------------------------------------
create or replace function public._merge_letter_counts(a jsonb, b jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_object_agg(k, coalesce((a ->> k)::int, 0) + coalesce((b ->> k)::int, 0)), '{}'::jsonb)
  from (
    select jsonb_object_keys(a) as k
    union
    select jsonb_object_keys(b) as k
  ) keys;
$$;

-- ---------------------------------------------------------------------------
-- 3. _best_peel_streak — longest run of consecutive 'peel' events for one profile in one room,
--    uninterrupted by a 'dump'. Standard gaps-and-islands: a running count of dumps seen so far
--    (window SUM ordered by time) is constant across a run of peels and increments at each dump,
--    so grouping peel rows by that running count clusters each unbroken run together; the largest
--    group is the longest streak.
-- ---------------------------------------------------------------------------
create or replace function public._best_peel_streak(p_room_id uuid, p_profile_id uuid, p_since timestamptz)
returns int
language sql
stable
as $$
  select coalesce(max(cnt), 0)
  from (
    select grp, count(*) as cnt
    from (
      select type,
             sum((type = 'dump')::int) over (order by id rows between unbounded preceding and current row) as grp
      from public.room_events
      where room_id = p_room_id
        and payload ->> 'actor' = p_profile_id::text
        and type in ('peel', 'dump')
        and created_at >= p_since
    ) tagged
    where type = 'peel'
    group by grp
  ) groups;
$$;

do $$
begin
  execute 'revoke all on function public._merge_letter_counts(jsonb,jsonb) from public, anon, authenticated';
  execute 'grant execute on function public._merge_letter_counts(jsonb,jsonb) to service_role';
  execute 'revoke all on function public._best_peel_streak(uuid,uuid,timestamptz) from public, anon, authenticated';
  execute 'grant execute on function public._best_peel_streak(uuid,uuid,timestamptz) to service_role';
end $$;

-- ---------------------------------------------------------------------------
-- 4. _archive_game_impl — drop choke tracking (nothing reads choke_count once the Stats tab tile
--    is gone), add best_peel_streak. Peel streak is multiplayer-only: for solo/xtina rows
--    v_peel_streak stays 0, and GREATEST(existing, 0) is a no-op, so no per-mode branching is
--    needed in the INSERT/UPDATE itself.
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

-- ---------------------------------------------------------------------------
-- 5. submit_game_summary — add the xtina guard archive_game already has (defense-in-depth; the
--    Worker already skips calling this RPC at all for xtina rooms), and tally first letters into
--    first_letter_counts alongside the existing first_letters set.
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
  end if;

  return jsonb_build_object(
    'ok', true,
    'longestWord', v_longest,
    'rarestWord', v_rarest,
    'wordCount', v_word_count
  );
end;
$$;
