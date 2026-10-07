-- Phase 4 easter-egg review fixes. Changed lines are marked -- [review]; everything else in each
-- function is verbatim from its latest definition (named per section). Same signatures
-- (create or replace — no new overloads); grants restated.
--
-- 1. GHOST masking leaked through room_events. room_players_public masked a ghosted player's
--    counts, but peel/dump/leave_room/start_game payloads carry 'tileCounts' (from _tile_counts)
--    and report_progress broadcasts 'remaining' — both readable by every room member over
--    Realtime. _tile_counts now NULLs a ghosted player's tileCount while the room is active
--    (null, not omitted: the entry, seat and array shape stay stable; no apps/web code reads
--    tileCounts today, and null matches room_players_public's mask). report_progress still
--    writes remaining_count but omits 'remaining' from the event once the caller is ghosted.
-- 2. submit_game_summary let a spoofed words:["SUPERCALI…"] set lifetime longest_word. That word
--    now counts only for the room's genuine supercali_win winner.
-- 3. report_egg_flags accepted GHOST in any mode / from a spectator. Now multiplayer players only.

-- ---------------------------------------------------------------------------
-- _tile_counts — verbatim from 20260706000002_rpcs.sql plus the [review] mask.
-- ---------------------------------------------------------------------------
create or replace function public._tile_counts(p_room_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'profileId', rp.profile_id, 'seat', rp.seat,
      'tileCount', case when rp.ghosted and r.status = 'active' then null else rp.tile_count end  -- [review]
    ) order by rp.seat),
    '[]'::jsonb)
  from public.room_players rp
  join public.rooms r on r.id = rp.room_id                                                        -- [review]
  where rp.room_id = p_room_id and not rp.is_spectator;
$$;

-- ---------------------------------------------------------------------------
-- report_progress — verbatim from 20260728000003_player_progress.sql plus the [review] lines.
-- ---------------------------------------------------------------------------
create or replace function public.report_progress(p_room_id uuid, p_profile uuid, p_remaining int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev int;
  v_ghosted boolean;   -- [review]
begin
  if p_remaining is null or p_remaining < 0 then
    raise exception 'INVALID_REMAINING' using errcode = 'P0001';
  end if;

  select remaining_count, ghosted into v_prev, v_ghosted from public.room_players  -- [review]
    where room_id = p_room_id and profile_id = p_profile
    for update;
  if not found then raise exception 'NOT_IN_ROOM' using errcode = 'P0002'; end if;

  if v_prev is distinct from p_remaining then
    update public.room_players set remaining_count = p_remaining
      where room_id = p_room_id and profile_id = p_profile;
    insert into public.room_events (room_id, type, payload)
      values (p_room_id, 'progress',
              case when v_ghosted                                                    -- [review]
                   then jsonb_build_object('profileId', p_profile)                   -- [review]
                   else jsonb_build_object('profileId', p_profile, 'remaining', p_remaining)
              end);
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- report_egg_flags — verbatim from 20261006000402_egg_room_state.sql plus the [review] gate.
-- ---------------------------------------------------------------------------
create or replace function public.report_egg_flags(p_room_id uuid, p_profile uuid, p_flags jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_rp public.room_players;
  v_flags jsonb := coalesce(p_flags, '{}'::jsonb);
  v_ghost boolean;
  v_freeze boolean;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_room.status <> 'active' then raise exception 'GAME_NOT_ACTIVE' using errcode = 'P0001'; end if;

  select * into v_rp from public.room_players
    where room_id = p_room_id and profile_id = p_profile
    for update;
  if not found then raise exception 'NOT_IN_ROOM' using errcode = 'P0002'; end if;

  -- jsonb equality, not a ::boolean cast: a non-boolean value is simply "not set", never a 22P02.
  v_ghost := (v_flags -> 'ghosted') = 'true'::jsonb
             and v_room.mode = 'multiplayer'      -- [review] GHOST only means something vs opponents
             and not v_rp.is_spectator;           -- [review]
  v_freeze := (v_flags -> 'freezeUsed') = 'true'::jsonb
              and v_room.mode = 'solo'
              and coalesce((v_room.mode_config ->> 'timed')::boolean, false);

  if v_ghost and not v_rp.ghosted then
    update public.room_players set ghosted = true where id = v_rp.id;
    insert into public.room_events (room_id, type, payload)
      values (p_room_id, 'progress', jsonb_build_object('profileId', p_profile, 'ghosted', true));
  end if;

  if v_freeze and not v_rp.freeze_used then
    update public.room_players set freeze_used = true where id = v_rp.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'ghosted', v_rp.ghosted or v_ghost,
    'freezeUsed', v_rp.freeze_used or v_freeze
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- submit_game_summary — verbatim from 20261006000405_egg_achievements.sql plus the [review] filter.
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
  -- [review] …except SUPERCALI…, which counts as a WORD only for the player who actually won this
  -- room via supercali_win. Otherwise anyone could put it in `words` and claim a 34-letter
  -- lifetime longest_word. (eggs_found below is unaffected — spoofable by spec.)
  select coalesce(array_agg(upper(w)), '{}') into v_words
    from jsonb_array_elements_text(coalesce(p_summary -> 'words', '[]'::jsonb)) w
    where (upper(w) ~ '^[A-Z]{2,20}$' or upper(w) = any (public._easter_egg_words()))
      and (upper(w) <> 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS'                       -- [review]
           or (v_room.win_kind = 'supercali' and v_room.winner_id = p_profile));  -- [review]

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

-- All four were service_role-only before this migration (internal helper / Worker-called RPCs);
-- restated so a replace can never widen them.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    '_tile_counts(uuid)', 'report_progress(uuid,uuid,integer)',
    'report_egg_flags(uuid,uuid,jsonb)', 'submit_game_summary(uuid,uuid,jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;
