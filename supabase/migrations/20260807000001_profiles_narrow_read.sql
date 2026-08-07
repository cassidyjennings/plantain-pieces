-- Narrow public.profiles' cross-account readability.
--
-- profiles_select_all (`for select to authenticated using (true)`) let ANY authenticated user
-- read every column of every profile row, not just their own. That was harmless for the columns
-- it was originally written around (display_name, avatar_config, streaks — all meant to be at
-- least somewhat cross-visible). It stopped being harmless the moment profiles.xtina_role and
-- profiles.xtina_enabled were added (migration 20260805000001): fetchMyProfile()'s own
-- `select('*')` on the CALLER'S OWN row runs on every app boot and every Profile page visit, so
-- the value sits in plain JSON in the browser's Network tab on every load — no snooping or
-- deliberate lookup required, just an open DevTools panel. The same wide-open policy also let any
-- OTHER authenticated account query any account's row directly, xtina fields included.
--
-- Narrowed to self-only, with a public view carrying exactly what a cross-account lookup
-- currently needs: fetchDisplayName() in apps/web/src/lib/rooms.ts (the Results screen's winner
-- name), the only client-side read of another account's profiles row in the app — everything
-- else (Lobby avatars, etc.) already reads a denormalized snapshot on room_players, not profiles.

drop policy if exists profiles_select_all on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = auth.uid());

create or replace view public.profiles_public
with (security_invoker = false) as
  select id, display_name, avatar_config, is_guest
  from public.profiles;

grant select on public.profiles_public to authenticated, anon;
