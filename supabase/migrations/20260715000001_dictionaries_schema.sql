-- Custom Dictionaries feature — presets table, a words RLS privacy fix, and a
-- listing view for a user's own custom word sets.

-- ---------------------------------------------------------------------------
-- dictionary_presets — a named, owner-scoped snapshot of a DictionaryConfig.
-- Re-saving under an existing name updates it in place (see save_dictionary_preset).
-- ---------------------------------------------------------------------------
create table public.dictionary_presets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  config jsonb not null,
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);

alter table public.dictionary_presets enable row level security;

create policy dictionary_presets_select_own on public.dictionary_presets
  for select to authenticated using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Privacy fix: the original words_select_all policy let any authenticated/anon
-- client read ANY row of public.words, including other users' custom word
-- lists — harmless for the base ENABLE1 list (public domain) but a real,
-- avoidable leak now that user-created custom sets are a real feature. Split
-- it into a base-only world-readable policy and an owner-scoped policy for
-- custom rows, mirroring the pattern custom_word_sets already uses.
-- ---------------------------------------------------------------------------
drop policy words_select_all on public.words;

create policy words_select_base on public.words
  for select to authenticated, anon using (custom_set_id is null);

create policy words_select_own_custom on public.words
  for select to authenticated using (
    custom_set_id is not null and exists (
      select 1 from public.custom_word_sets cws
      where cws.id = words.custom_set_id and cws.owner_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- custom_word_sets_with_count — the listing source for "My Dictionaries" so the
-- client can show word counts without ever bulk-fetching word content.
-- security_invoker = false → view runs as owner and bypasses base-table RLS;
-- the WHERE clause (using auth.uid()) is what gates access, same as rooms_public.
-- ---------------------------------------------------------------------------
create view public.custom_word_sets_with_count
with (security_invoker = false) as
  select cws.id, cws.owner_id, cws.name, cws.created_at, count(w.id) as word_count
  from public.custom_word_sets cws
  left join public.words w on w.custom_set_id = cws.id
  where cws.owner_id = auth.uid()
  group by cws.id;

grant select on public.custom_word_sets_with_count to authenticated;
