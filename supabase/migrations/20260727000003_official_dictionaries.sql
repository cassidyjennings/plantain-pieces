-- Official (built-in) language dictionaries: English, Español, Français, Deutsch.
--
-- Model: an *official* dictionary is a public.custom_word_sets row with owner_id IS NULL. It then
-- flows through DictionaryConfig.customSetIds exactly like a user's own set, so nothing about the
-- config shape changes and no stored dictionary_config on a live room or preset needs rewriting.
--
-- English stays the custom_set_id IS NULL "base" partition driven by baseEnabled — the seeder just
-- swaps ENABLE1's rows for the larger Collins/SOWPODS list, so every existing config with
-- baseEnabled: true silently upgrades. The UI presents all four as one "Languages" group; the
-- base-vs-set split is an implementation detail below that line.
--
-- Words are loaded by scripts/seed-dictionary.mjs, which normalizes through the shared
-- normalizeWord() so accents fold onto their base letter (Ñ→N, ß→SS) and stay playable with the
-- English A-Z tile set.

-- ---------------------------------------------------------------------------
-- custom_word_sets: stable slug + stored word_count for official sets
-- ---------------------------------------------------------------------------
alter table public.custom_word_sets
  add column if not exists slug text,
  add column if not exists word_count int;

-- Stable key the seeder upserts on, so re-running never duplicates a language. User-owned sets
-- leave this NULL, and Postgres allows unlimited NULLs under a unique constraint.
create unique index if not exists custom_word_sets_slug_unique
  on public.custom_word_sets (slug) where slug is not null;

comment on column public.custom_word_sets.slug is
  'Stable identifier for official (owner_id IS NULL) dictionaries, e.g. es/fr/de. NULL for user sets.';
comment on column public.custom_word_sets.word_count is
  'Materialized count for official sets only — counting ~2M rows live on every picker open would seq-scan. User sets get their count from custom_word_sets_with_count instead.';

-- ---------------------------------------------------------------------------
-- RLS: everyone can read official sets and their words
-- ---------------------------------------------------------------------------
-- custom_word_sets previously had only cws_select_own (owner_id = auth.uid()), which never matches
-- an owner-less row, so official sets would have been invisible to every client.
drop policy if exists cws_select_official on public.custom_word_sets;
create policy cws_select_official on public.custom_word_sets
  for select to authenticated, anon using (owner_id is null);

-- Mirrors words_select_own_custom (20260715000001) for the official partition. Without this the
-- rows exist but no client can read them, and the words_select_base policy only covers the
-- custom_set_id IS NULL base.
drop policy if exists words_select_official on public.words;
create policy words_select_official on public.words
  for select to authenticated, anon using (
    custom_set_id is not null and exists (
      select 1 from public.custom_word_sets cws
      where cws.id = words.custom_set_id and cws.owner_id is null
    )
  );

grant select on public.custom_word_sets to anon;

-- ---------------------------------------------------------------------------
-- official_word_sets — the listing source for the "Languages" group in the picker.
-- security_invoker = false so it bypasses base-table RLS; the WHERE clause is the gate, matching
-- the custom_word_sets_with_count / rooms_public pattern.
-- ---------------------------------------------------------------------------
create or replace view public.official_word_sets
with (security_invoker = false) as
  select cws.id, cws.slug, cws.name, coalesce(cws.word_count, 0) as word_count
  from public.custom_word_sets cws
  where cws.owner_id is null;

grant select on public.official_word_sets to authenticated, anon;

-- ---------------------------------------------------------------------------
-- _validate_dictionary_config: accept official sets alongside the caller's own
-- ---------------------------------------------------------------------------
-- Carried over verbatim from 20260715000002_dictionaries_rpcs.sql except the ownership check,
-- which now also admits owner_id IS NULL. This single predicate is what gates whether an official
-- dictionary can be selected at all — create_room, set_dictionary_config, save_dictionary_preset
-- and create_solo_room all funnel through here.
create or replace function public._validate_dictionary_config(p_owner uuid, p_config jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_min_len int;
  v_max_len int;
  v_base_enabled boolean;
  v_custom_ids uuid[];
  v_selectable_count int;
begin
  v_min_len := coalesce((p_config ->> 'minLength')::int, 2);
  v_max_len := nullif(p_config ->> 'maxLength', 'null')::int;
  v_base_enabled := coalesce((p_config ->> 'baseEnabled')::boolean, true);

  begin
    select coalesce(array_agg(distinct value::uuid), '{}')
      into v_custom_ids
      from jsonb_array_elements_text(coalesce(p_config -> 'customSetIds', '[]'::jsonb));
  exception when invalid_text_representation then
    raise exception 'INVALID_CUSTOM_SET' using errcode = 'P0001';
  end;

  if v_min_len < 1 or v_min_len > 20 then
    raise exception 'INVALID_DICTIONARY_CONFIG' using errcode = 'P0001';
  end if;
  if v_max_len is not null and (v_max_len < v_min_len or v_max_len > 24) then
    raise exception 'INVALID_DICTIONARY_CONFIG' using errcode = 'P0001';
  end if;
  if not v_base_enabled and coalesce(array_length(v_custom_ids, 1), 0) = 0 then
    raise exception 'NO_WORD_SOURCE' using errcode = 'P0001';
  end if;

  if coalesce(array_length(v_custom_ids, 1), 0) > 0 then
    select count(*) into v_selectable_count
      from public.custom_word_sets
      where id = any (v_custom_ids)
        and (owner_id = p_owner or owner_id is null);
    if v_selectable_count <> array_length(v_custom_ids, 1) then
      raise exception 'INVALID_CUSTOM_SET' using errcode = 'P0001';
    end if;
  end if;

  return jsonb_build_object(
    'minLength', v_min_len,
    'maxLength', v_max_len,
    'baseEnabled', v_base_enabled,
    'excludedTopics', '[]'::jsonb,
    'customSetIds', to_jsonb(v_custom_ids)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- find_invalid_words: make the lookup index-driven again
-- ---------------------------------------------------------------------------
-- The original predicate OR'd the two word partitions inside a single EXISTS:
--
--   where dw.word = w::citext
--     and ((base_enabled and dw.custom_set_id is null) or dw.custom_set_id = any (custom_ids))
--
-- Two PARTIAL indexes cover this table — words_base_unique (word) WHERE custom_set_id IS NULL and
-- words_custom_unique (word, custom_set_id) WHERE custom_set_id IS NOT NULL — and an OR spanning
-- both means the planner can't use either. At 173k rows that was a cheap seq scan nobody noticed.
-- At 1.97M rows it measured a 1.97M-row Seq Scan taking ~2.3 SECONDS per call, and this runs on a
-- debounce while the player is typing.
--
-- Splitting into one EXISTS per partition lets each one hit its own index: same result, measured
-- 2282ms -> 6.6ms (~350x) on the full four-language corpus. Everything else is carried over
-- verbatim from 20260706000002_rpcs.sql.
create or replace function public.find_invalid_words(p_room_id uuid, p_words text[])
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  cfg jsonb;
  min_len int;
  max_len int;
  base_enabled boolean;
  custom_ids uuid[];
  invalid text[];
begin
  select dictionary_config into cfg from public.rooms where id = p_room_id;
  if cfg is null then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;

  min_len := coalesce((cfg ->> 'minLength')::int, 2);
  max_len := nullif(cfg ->> 'maxLength', 'null')::int;
  base_enabled := coalesce((cfg ->> 'baseEnabled')::boolean, true);
  select coalesce(array_agg(value::uuid), '{}')
    into custom_ids
    from jsonb_array_elements_text(coalesce(cfg -> 'customSetIds', '[]'::jsonb));

  -- The length bounds stay INSIDE the negation, exactly as they were inside the original
  -- NOT EXISTS: a word violating min/max length must be reported INVALID, not silently passed.
  -- (Hoisting them into the outer WHERE would invert that and let short words through.)
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
-- Storage cleanup — the words table grows ~11x (172,823 -> 1,967,687 rows), so dead weight that
-- was invisible before now costs real money on a 500 MB free tier. Measured locally: this takes
-- the table from 341 MB to 214 MB (and the whole DB from 354 MB to 227 MB).
--
-- IMPORTANT: run this migration BEFORE seeding. Dropping a column is a metadata-only operation,
-- but reclaiming the space needs a VACUUM FULL that rewrites the table under an ACCESS EXCLUSIVE
-- lock. Doing it while the table still holds only the old ~173k ENABLE1 rows is near-instant;
-- doing it after a 2M-row load would lock the table for minutes.
-- ---------------------------------------------------------------------------

-- words.length is written by the seeder and the custom-set RPCs but read by NOTHING:
-- find_invalid_words filters char_length(w) on the unnested *input* array, never the column.
-- The column stays (harmless, and the insert paths reference it) but its index goes.
drop index if exists public.words_length_idx;

-- topics is a stubbed feature: DictionaryConfig.excludedTopics is a documented no-op, no row has
-- ever been tagged, and nothing in SQL or the app reads the column. An empty text[] still costs
-- ~24 bytes of array header per row, so at 2M rows the column itself is ~48 MB.
drop index if exists public.words_topics_idx;
alter table public.words drop column if exists topics;

-- words.id is a surrogate key nothing looks anything up by — every read matches on `word`. Its
-- primary-key index alone was 42 MB. The one dependency is the count() in
-- custom_word_sets_with_count, so that view is redefined first to count a different column.
-- (Recreated verbatim from 20260715000001_dictionaries_schema.sql apart from that count.)
create or replace view public.custom_word_sets_with_count
with (security_invoker = false) as
  select cws.id, cws.owner_id, cws.name, cws.created_at, count(w.custom_set_id) as word_count
  from public.custom_word_sets cws
  left join public.words w on w.custom_set_id = cws.id
  where cws.owner_id = auth.uid()
  group by cws.id;

alter table public.words drop column if exists id;
