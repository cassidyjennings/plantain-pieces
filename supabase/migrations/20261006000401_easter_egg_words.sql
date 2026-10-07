-- Phase 4 easter eggs: egg words are ALWAYS valid, in every dictionary and every mode, regardless
-- of the room's dictionary_config or length bounds.
--
-- _easter_egg_words() is the SQL twin of packages/shared/src/easterEggs.ts EASTER_EGG_WORDS —
-- same words, same order (scripts/smoke-easter-eggs.mjs asserts it). Keep them in sync.
--
-- _find_invalid_words_cfg strips egg words out of its input BEFORE the dictionary query. That is a
-- separate pre-filter on purpose: the dictionary query's two separate EXISTS blocks (one per
-- partial index) and its length bounds INSIDE the negation are carried over verbatim — OR-ing an
-- egg test into that WHERE is exactly the kind of change that once turned this into a 2.3-second
-- seq scan (see 20260727000003's header). Because this helper backs find_invalid_words (/validate
-- and Plantains) and submit_game_summary, eggs are accepted everywhere at once.

create or replace function public._easter_egg_words()
returns text[]
language sql
immutable
parallel safe
set search_path = public
as $$
  select array['MIT', 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS', 'GHOST', 'FREEZE']::text[]
$$;

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
  v_candidates text[];  -- [phase4]
begin
  min_len := coalesce((cfg ->> 'minLength')::int, 2);
  max_len := nullif(cfg ->> 'maxLength', 'null')::int;
  base_enabled := coalesce((cfg ->> 'baseEnabled')::boolean, true);
  select coalesce(array_agg(value::uuid), '{}')
    into custom_ids
    from jsonb_array_elements_text(coalesce(cfg -> 'customSetIds', '[]'::jsonb));

  -- [phase4] Egg short-circuit: egg words never reach the dictionary query at all.
  select coalesce(array_agg(w), '{}')
    into v_candidates
  from unnest(p_words) as w
  where not (upper(w) = any (public._easter_egg_words()));

  select coalesce(array_agg(w), '{}')
    into invalid
  from unnest(v_candidates) as w
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

do $$
begin
  execute 'revoke all on function public._easter_egg_words() from public, anon, authenticated';
  execute 'grant execute on function public._easter_egg_words() to service_role';
  execute 'revoke all on function public._find_invalid_words_cfg(jsonb,text[]) from public, anon, authenticated';
  execute 'grant execute on function public._find_invalid_words_cfg(jsonb,text[]) to service_role';
end $$;
