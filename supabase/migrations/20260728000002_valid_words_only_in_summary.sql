-- The end-of-game summary trusted the client's raw word list unfiltered. A losing player's
-- final grid is whatever half-built state they were in when the game ended -- only the
-- WINNER's grid is ever dictionary-checked, at Plantains time -- so submit_game_summary was
-- happily reporting a mid-typed fragment ("REDUND", on the way to REDUNDANT) as that player's
-- longest word, feeding it into their lifetime stats, match history, and the Word Nerd
-- achievement.
--
-- Fix: filter every player's submitted words through the room's actual dictionary before any
-- of that is computed. Reuses find_invalid_words' exact filtering logic rather than
-- duplicating it -- extracted into a config-driven helper so both callers share one
-- implementation.

-- ---------------------------------------------------------------------------
-- _find_invalid_words_cfg — the filtering logic from find_invalid_words, minus the room lookup,
-- so it can be reused wherever a dictionary_config is already in hand (find_invalid_words itself,
-- and now submit_game_summary). Keep the two separate EXISTS blocks and the length bounds INSIDE
-- the negation exactly as before -- collapsing them is what previously turned this into a
-- 2.3-SECOND unindexed seq scan on the full word corpus (see 20260727000003's header note); this
-- is a verbatim carry-over of that already-fixed shape, not a rewrite.
-- ---------------------------------------------------------------------------
create or replace function public._find_invalid_words_cfg(p_cfg jsonb, p_words text[])
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  cfg jsonb := coalesce(p_cfg, '{}'::jsonb);
  min_len int;
  max_len int;
  base_enabled boolean;
  custom_ids uuid[];
  invalid text[];
begin
  min_len := coalesce((cfg ->> 'minLength')::int, 2);
  max_len := nullif(cfg ->> 'maxLength', 'null')::int;
  base_enabled := coalesce((cfg ->> 'baseEnabled')::boolean, true);
  select coalesce(array_agg(value::uuid), '{}')
    into custom_ids
    from jsonb_array_elements_text(coalesce(cfg -> 'customSetIds', '[]'::jsonb));

  select coalesce(array_agg(w), '{}')
    into invalid
  from unnest(p_words) as w
  where not (
    char_length(w) >= min_len
    and (max_len is null or char_length(w) <= max_len)
    and (
      (base_enabled and exists (
        select 1 from public.words dw
        where dw.word = w::citext and dw.custom_set_id is null
      ))
      or exists (
        select 1 from public.words dw
        where dw.word = w::citext and dw.custom_set_id = any (custom_ids)
      )
    )
  );
  return invalid;
end;
$$;

-- ---------------------------------------------------------------------------
-- find_invalid_words — now a thin wrapper. Behavior (including the ROOM_NOT_FOUND check) and
-- signature are unchanged; existing grants (service_role only) survive the create-or-replace.
-- ---------------------------------------------------------------------------
create or replace function public.find_invalid_words(p_room_id uuid, p_words text[])
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  cfg jsonb;
begin
  select dictionary_config into cfg from public.rooms where id = p_room_id;
  if cfg is null then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;
  return public._find_invalid_words_cfg(cfg, p_words);
end;
$$;

-- ---------------------------------------------------------------------------
-- submit_game_summary — same as 20260721000002, with the client's words filtered through the
-- game's actual dictionary_config (durably snapshotted onto `games` by archive_game) before any
-- of the derived stats are computed. v_words (the WORD_PATTERN-shaped extraction) is kept as-is
-- for the filter's input; every downstream computation switches from v_words to v_valid_words.
-- unnest/array_agg over a filtered `where` preserves order and duplicates, so a word played
-- twice on the board still counts twice in total_words/total_word_length.
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

  select string_agg(distinct substr(x, 1, 1), '' order by substr(x, 1, 1))
    into v_new_letters from unnest(v_valid_words) x;
  v_new_letters := coalesce(v_new_letters, '');

  -- Always refresh the descriptive columns. words_played now stores the FILTERED list -- it's a
  -- display field (match history), and showing an invalid fragment there is the same bug as the
  -- Results tile.
  update public.game_players set
    final_placed_count = v_placed,
    words_played = to_jsonb(coalesce(v_valid_words, '{}'::text[])),
    longest_word = v_longest,
    rarest_word = v_rarest,
    rarest_word_score = v_rarest_score,
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
-- _find_invalid_words_cfg reads public.words as SECURITY DEFINER, bypassing its RLS split
-- (words_select_base / words_select_own_custom) the same way find_invalid_words already does —
-- lock it down the same way, matching the _draw_from_bunch / _tile_counts precedent for internal
-- helpers that touch RLS-protected tables. (find_invalid_words and submit_game_summary keep
-- their existing grants — same signatures, create-or-replace preserves them.)
-- ---------------------------------------------------------------------------
do $$
begin
  execute 'revoke all on function public._find_invalid_words_cfg(jsonb,text[]) from public, anon, authenticated';
  execute 'grant execute on function public._find_invalid_words_cfg(jsonb,text[]) to service_role';
end $$;
