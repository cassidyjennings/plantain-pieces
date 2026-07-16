-- Base GRANT for the new dictionary_presets table — RLS policies alone are not
-- sufficient on this Supabase version (see 20260710000001's note). words and
-- custom_word_sets already have their grants from that migration; the RLS
-- policy split in 20260715000001 doesn't change which roles need table access,
-- only which rows they can see, so nothing to add there.
grant select on public.dictionary_presets to authenticated;
