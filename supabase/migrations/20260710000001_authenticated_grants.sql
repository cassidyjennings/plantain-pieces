-- Same root cause as 20260706000003 (service_role): newer Supabase no longer
-- implicitly grants table access to Data API roles. An RLS policy alone is
-- necessary but NOT sufficient — Postgres still checks the base table GRANT
-- first. Discovered because filtered Realtime `postgres_changes` subscriptions
-- (which run an authorization check as the connecting role) were silently
-- failing to register for `authenticated` on room_events, while unfiltered
-- subscriptions happened not to exercise that check path. Every table with an
-- `authenticated`/`anon` RLS policy needs its matching base GRANT.
grant select on public.profiles to authenticated;
grant update on public.profiles to authenticated;

grant select on public.room_players to authenticated;
grant select on public.room_events to authenticated;

grant select on public.words to authenticated, anon;
grant select on public.custom_word_sets to authenticated;
grant select on public.friends to authenticated;
grant select on public.achievements to authenticated;
