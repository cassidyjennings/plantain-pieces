-- Account / Profile system — RPCs. All SECURITY DEFINER, called by the Worker
-- (service_role) only. Locked down in the trailing do-block, mirroring
-- 20260706000002 / 20260715000002.

-- ---------------------------------------------------------------------------
-- word_rarity — SQL mirror of the shared wordRarity() proxy (packages/shared/
-- src/stats.ts LETTER_RARITY). Scarcity weight per letter from the 144-tile
-- distribution; word score = sum. Keep in sync with the TS table.
-- ---------------------------------------------------------------------------
create or replace function public.word_rarity(p_word text)
returns int
language sql
immutable
as $$
  select coalesce(sum(
    case ch
      when 'E' then 1 when 'A' then 1
      when 'I' then 2 when 'O' then 2 when 'N' then 2 when 'R' then 2 when 'T' then 2
      when 'S' then 3 when 'D' then 3 when 'U' then 3
      when 'L' then 4
      when 'G' then 5
      when 'B' then 6 when 'C' then 6 when 'F' then 6 when 'H' then 6 when 'M' then 6
      when 'P' then 6 when 'V' then 6 when 'W' then 6 when 'Y' then 6
      when 'J' then 9 when 'K' then 9 when 'Q' then 9 when 'X' then 9 when 'Z' then 9
      else 0
    end), 0)::int
  from unnest(string_to_array(upper(coalesce(p_word, '')), null)) as ch;
$$;

-- Word Nerd rarity threshold — keep in sync with WORD_NERD_THRESHOLD in stats.ts.
-- (Inlined as a literal below; documented here.)

-- ---------------------------------------------------------------------------
-- _unlock_achievement — idempotent unlock (once per user per type).
-- ---------------------------------------------------------------------------
create or replace function public._unlock_achievement(p_user uuid, p_type text, p_meta jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.achievements (user_id, type, meta)
  values (p_user, p_type, coalesce(p_meta, '{}'::jsonb))
  on conflict (user_id, type) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- update_profile — validates + persists display name / avatar. Either field is
-- optional (null = leave unchanged). Validation mirrors packages/shared
-- validateDisplayName + validateAvatarConfig.
-- ---------------------------------------------------------------------------
create or replace function public.update_profile(
  p_profile uuid, p_display_name text, p_avatar_config jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_base text;
  v_slot text;
  v_allowed jsonb := jsonb_build_object(
    'base', jsonb_build_array('ripe','green','golden','speckled'),
    'hat', jsonb_build_array('none','straw','party','crown','beanie'),
    'glasses', jsonb_build_array('none','round','shades','star'),
    'hair', jsonb_build_array('none','swoop','curls','mohawk')
  );
  v_row public.profiles;
begin
  if p_display_name is not null then
    v_name := trim(p_display_name);
    if char_length(v_name) < 1 then raise exception 'EMPTY' using errcode = 'P0001'; end if;
    if char_length(v_name) > 20 then raise exception 'TOO_LONG' using errcode = 'P0001'; end if;
    -- Defense-in-depth blocklist. The authoritative allowlist check (letters of any
    -- script, digits, space, _ and -) is the shared validateDisplayName() the Worker runs
    -- before calling this; Postgres regex can't cleanly express \p{L}, so here we only
    -- reject control characters and punctuation/symbols we never allow.
    if v_name ~ '[[:cntrl:]<>;:/\\"''`{}\[\]()@#$%^&*=+|~]' then
      raise exception 'INVALID_CHARS' using errcode = 'P0001';
    end if;
    update public.profiles set display_name = v_name where id = p_profile;
  end if;

  if p_avatar_config is not null then
    v_base := p_avatar_config ->> 'base';
    if v_base is null or not (v_allowed -> 'base' ? v_base) then
      raise exception 'INVALID_AVATAR_CONFIG' using errcode = 'P0001';
    end if;
    foreach v_slot in array array['hat','glasses','hair'] loop
      if p_avatar_config ? v_slot and not (v_allowed -> v_slot ? (p_avatar_config ->> v_slot)) then
        raise exception 'INVALID_AVATAR_CONFIG' using errcode = 'P0001';
      end if;
    end loop;
    update public.profiles set avatar_config = p_avatar_config where id = p_profile;
  end if;

  select * into v_row from public.profiles where id = p_profile;
  if not found then raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'id', v_row.id, 'displayName', v_row.display_name,
    'isGuest', v_row.is_guest, 'avatarConfig', v_row.avatar_config
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- archive_game — Phase 1 durable archival + server-authoritative rollup. Called
-- by the Worker right after finish_game, in the same request that ends the game
-- (so room_players / room_events are still present). Idempotent per finished game.
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
  v_new_streak int;
  v_nail_biter boolean;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;

  -- Idempotency: if this finished game was already archived, return it.
  select id into v_existing from public.games
    where room_code = v_room.code and finished_at = v_room.finished_at limit 1;
  if v_existing is not null then
    return jsonb_build_object('gameId', v_existing, 'alreadyArchived', true);
  end if;

  select count(*) filter (where not is_spectator),
         count(*) filter (where is_spectator)
    into v_player_count, v_spectator_count
    from public.room_players where room_id = p_room_id;

  select min(created_at) into v_split_at
    from public.room_events where room_id = p_room_id and type = 'game_started';

  select min(final_tiles) into v_min_tiles from (
    select tile_count as final_tiles from public.room_players
    where room_id = p_room_id and not is_spectator and profile_id <> p_winner
  ) s;

  insert into public.games (
    room_code, winner_id, player_count, spectator_count,
    dictionary_config, started_at, finished_at, duration_ms
  ) values (
    v_room.code, p_winner, v_player_count, v_spectator_count,
    v_room.dictionary_config, v_room.started_at, v_room.finished_at,
    case when v_room.started_at is not null and v_room.finished_at is not null
      then (extract(epoch from (v_room.finished_at - v_room.started_at)) * 1000)::int end
  ) returning id into v_game_id;

  v_game_date := coalesce(v_room.finished_at, now())::date;

  -- Nail Biter signal: an opponent's Plantains attempt was rejected within 5s BEFORE
  -- the win (a real near-miss the winner beat), measured against the room's finished_at
  -- (the win time). Attempts arriving after archival can't be known here — we look
  -- backward only; see the plan's note.
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
      where room_id = p_room_id and type = 'peel' and payload ->> 'actor' = v_p.profile_id::text;
    select count(*) into v_dumps from public.room_events
      where room_id = p_room_id and type = 'dump' and payload ->> 'actor' = v_p.profile_id::text;
    select min(created_at) into v_first_peel_at from public.room_events
      where room_id = p_room_id and type = 'peel' and payload ->> 'actor' = v_p.profile_id::text;
    v_first_peel_ms := case when v_first_peel_at is not null and v_split_at is not null
      then (extract(epoch from (v_first_peel_at - v_split_at)) * 1000)::int end;

    v_is_winner := v_p.profile_id = p_winner;
    -- Choke proxy: a non-winner tied for the fewest total tiles (closest to out) but
    -- didn't win. Server-authoritative from tile_count; refined later if desired.
    v_is_choke := (not v_is_winner) and v_min_tiles is not null and v_p.tile_count = v_min_tiles;

    select coalesce(jsonb_agg(jsonb_build_object(
             'profileId', o.profile_id, 'displayName', o.display_name,
             'seat', o.seat, 'isWinner', o.profile_id = p_winner)), '[]'::jsonb)
      into v_opponents
      from public.room_players o
      where o.room_id = p_room_id and not o.is_spectator and o.profile_id <> v_p.profile_id;

    insert into public.game_players (
      game_id, profile_id, seat, display_name, is_winner,
      final_tile_count, peels, dumps, first_peel_ms, opponents
    ) values (
      v_game_id, v_p.profile_id, v_p.seat, v_p.display_name, v_is_winner,
      v_p.tile_count, v_peels, v_dumps, v_first_peel_ms, v_opponents
    );

    -- Lifetime rollup (server-authoritative parts). Compute streak from the prior row.
    select * into v_stat from public.profile_stats where profile_id = v_p.profile_id;
    if not found then
      v_new_streak := 1;
      insert into public.profile_stats (
        profile_id, games_played, games_won, total_peels, total_dumps,
        fastest_peel_ms, choke_count, current_streak, longest_streak,
        last_played_date, updated_at
      ) values (
        v_p.profile_id, 1, (v_is_winner)::int, v_peels, v_dumps,
        v_first_peel_ms, (v_is_choke)::int, v_new_streak, v_new_streak,
        v_game_date, now()
      );
    else
      if v_stat.last_played_date = v_game_date then
        v_new_streak := v_stat.current_streak;               -- already played today
      elsif v_stat.last_played_date = v_game_date - 1 then
        v_new_streak := v_stat.current_streak + 1;           -- consecutive day
      else
        v_new_streak := 1;                                   -- gap or first
      end if;
      update public.profile_stats set
        games_played = v_stat.games_played + 1,
        games_won = v_stat.games_won + (v_is_winner)::int,
        total_peels = v_stat.total_peels + v_peels,
        total_dumps = v_stat.total_dumps + v_dumps,
        fastest_peel_ms = least(
          coalesce(v_stat.fastest_peel_ms, 2147483647),
          coalesce(v_first_peel_ms, 2147483647)),
        choke_count = v_stat.choke_count + (v_is_choke)::int,
        current_streak = v_new_streak,
        longest_streak = greatest(v_stat.longest_streak, v_new_streak),
        last_played_date = v_game_date,
        updated_at = now()
      where profile_id = v_p.profile_id;
    end if;
    -- Normalize the sentinel back to null if no peel ever happened for anyone.
    update public.profile_stats set fastest_peel_ms = null
      where profile_id = v_p.profile_id and fastest_peel_ms = 2147483647;

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
    -- Lifetime-threshold achievements (read the freshly-updated rollup).
    select * into v_stat from public.profile_stats where profile_id = v_p.profile_id;
    if v_stat.games_played >= 100 then
      perform public._unlock_achievement(v_p.profile_id, 'century_club', jsonb_build_object('games', v_stat.games_played));
    end if;
    if v_stat.total_peels >= 1000 then
      perform public._unlock_achievement(v_p.profile_id, 'peel_machine', jsonb_build_object('peels', v_stat.total_peels));
    end if;
  end loop;

  return jsonb_build_object('gameId', v_game_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- submit_game_summary — Phase 2 per-player merge of the client end-of-game
-- summary. Loosely validated (the Worker also validates via shared code). The
-- profile_stats word rollup is applied at most once per game_player (first
-- submission wins); descriptive columns refresh on every call. Idempotent.
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
  v_words text[];
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

  -- Extract WORD_PATTERN-shaped words (defense-in-depth; Worker already validated).
  select coalesce(array_agg(upper(w)), '{}') into v_words
    from jsonb_array_elements_text(coalesce(p_summary -> 'words', '[]'::jsonb)) w
    where upper(w) ~ '^[A-Z]{2,20}$';

  v_word_count := coalesce(array_length(v_words, 1), 0);
  select coalesce(sum(char_length(x)), 0) into v_total_len from unnest(v_words) x;

  select x into v_longest from unnest(v_words) x order by char_length(x) desc, x limit 1;
  v_longest_len := coalesce(char_length(v_longest), 0);

  select x, public.word_rarity(x) into v_rarest, v_rarest_score
    from unnest(v_words) x order by public.word_rarity(x) desc, x limit 1;
  v_rarest_score := coalesce(v_rarest_score, 0);

  v_placed := nullif(p_summary ->> 'placedCount', '')::int;
  -- Clamp an absurd placed count to the server-known tile total.
  if v_placed is not null and v_placed > v_gp.final_tile_count then
    v_placed := v_gp.final_tile_count;
  end if;

  select string_agg(distinct substr(x, 1, 1), '' order by substr(x, 1, 1))
    into v_new_letters from unnest(v_words) x;
  v_new_letters := coalesce(v_new_letters, '');

  -- Always refresh the descriptive columns.
  update public.game_players set
    final_placed_count = v_placed,
    words_played = coalesce(p_summary -> 'words', '[]'::jsonb),
    longest_word = v_longest,
    rarest_word = v_rarest,
    rarest_word_score = v_rarest_score,
    move_stats = coalesce(p_summary -> 'moveStats', '{}'::jsonb)
  where id = v_gp.id;

  -- Roll into lifetime word stats only once per game_player.
  if not v_gp.summary_applied then
    select * into v_stat from public.profile_stats where profile_id = p_profile;
    -- profile_stats row is guaranteed to exist (archive_game created it).
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
    where profile_id = p_profile;

    update public.game_players set summary_applied = true where id = v_gp.id;

    -- Word-based achievements.
    if exists (select 1 from unnest(v_words) x where public.word_rarity(x) >= 30) then
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
-- Lock down: Worker (service_role) only.
-- ---------------------------------------------------------------------------
do $$
declare
  fn text;
  action_fns text[] := array[
    'update_profile(uuid,text,jsonb)',
    '_unlock_achievement(uuid,text,jsonb)',
    'archive_game(uuid,uuid)',
    'submit_game_summary(uuid,uuid,jsonb)'
  ];
begin
  foreach fn in array action_fns loop
    execute format('revoke all on function public.%s from public, anon, authenticated;', fn);
    execute format('grant execute on function public.%s to service_role;', fn);
  end loop;
  -- word_rarity is a pure helper; safe to leave callable, but keep it service_role-only
  -- for consistency (clients use the shared TS version).
  execute 'revoke all on function public.word_rarity(text) from public, anon, authenticated;';
  execute 'grant execute on function public.word_rarity(text) to service_role;';
end $$;
