-- Make GUEST accounts scale with players, not with page views.
--
-- 20260728000006 fixed abandoned rooms; anonymous auth users were the other half of the same
-- problem and were left alone. Nothing has ever deleted one: handle_new_user() creates a
-- profiles row for every auth.users insert (anonymous included), and the ONLY removal path in
-- the whole codebase is the user-clicked Delete Account button (prepare_account_deletion +
-- auth.admin.deleteUser). There is no pg_cron in this project and no session timebox configured,
-- so auth.sessions / auth.refresh_tokens never expire either.
--
-- The creation rate is worse than one-per-player, for three compounding reasons:
--   1. Auth storage is sessionStorage-scoped (apps/web/src/lib/supabase.ts) so that two tabs are
--      two players — which means every new TAB mints a permanent anonymous user.
--   2. signOut() immediately starts a fresh anonymous session, so every sign-out mints another.
--   3. The app opens a session on page load, so a visitor who never plays still gets one.
-- Net: the row count tracks page views. Measured ~693 B of heap per guest across auth.users
-- (153 B) + auth.sessions (210 B) + auth.refresh_tokens (144 B) + profiles (90 B), plus 23
-- indexes across those three auth tables — call it ~1.5-2 KB each.
--
-- Deleting a guest must take EVERYTHING with them. Two columns in the auth schema reference a
-- user without a foreign key and so are not covered by the cascade — auth.refresh_tokens.user_id
-- and auth.flow_state.user_id/linking_target_id — and both are cleared explicitly below. Every
-- other reference cascades; see the comment on the delete for the full graph.
--
-- Same shape as the room sweep: opportunistic, no cron. Deliberately hung off
-- _sweep_stale_rooms() rather than off create_room/create_solo_room directly — those two are
-- long functions that would have to be reproduced verbatim by a `create or replace`, and every
-- such copy is a chance to silently drift. _sweep_stale_rooms() is already called from both
-- call sites and is short enough to restate exactly.

-- ---------------------------------------------------------------------------
-- Candidate index.
-- ---------------------------------------------------------------------------

-- Drives the candidate scan off OUR table, not auth.users. profiles.created_at is stamped by
-- handle_new_user() in the same transaction as the auth.users insert, so it's the same instant,
-- and this keeps the sweep from needing any DDL inside the auth schema (GoTrue owns that schema
-- and runs its own migrations there — adding our index to it would be asking for a conflict).
create index if not exists profiles_guest_sweep_idx
  on public.profiles (created_at)
  where is_guest;

-- ---------------------------------------------------------------------------
-- The sweep.
-- ---------------------------------------------------------------------------

create or replace function public._sweep_stale_guests(p_limit int default 500)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  v_deleted int;
begin
  -- 10 days, vs the rooms' 24h. A room is worthless the moment its game ends; a guest is a
  -- person who might still have the tab open, so the window is an order of magnitude wider — but
  -- a guest session cannot outlive its tab anyway, so a guest untouched for 10 days is one whose
  -- session is already unrecoverable.
  select array_agg(c.id) into v_ids
  from (
    select p.id
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.is_guest
      and p.created_at < now() - interval '10 days'
      -- Three independent reads of "is this really a guest", because they can disagree and the
      -- consequence of a false positive is permanent. is_guest is set by our own trigger on
      -- identity link; is_anonymous is GoTrue's own flag; the identities check is the ground
      -- truth both of those are derived from.
      and u.is_anonymous
      and not exists (
        select 1 from auth.identities i
        where i.user_id = p.id and i.provider is distinct from 'anonymous'
      )
      -- Never touch an xtina role holder. The spec says neither role can be a guest, so this
      -- should be unreachable — which is exactly why it's cheap to assert.
      and p.xtina_role is null
      -- NOTE: stats, achievements, custom word sets and presets are deliberately NOT protective.
      -- A guest can never sign back in — auth is sessionStorage-scoped, so closing the tab
      -- destroys the session permanently and there is no email or password to recover it with.
      -- Everything a guest accumulates is therefore already unreachable to them; keeping it would
      -- preserve rows that literally nobody can ever read. The product answer to "I don't want to
      -- lose my stats" is to link a Google account, which the Profile UI now states outright by
      -- locking the Stats and Achievements tabs behind that prompt for guests.
      --
      -- The only things that still protect a guest are the ones where deleting them would break
      -- something for SOMEBODY ELSE, or would be structurally invalid:
      --
      -- room_players.profile_id CASCADES, so without this a sweep would silently yank a player
      -- out of a room mid-game rather than refusing to delete them.
      and not exists (select 1 from public.room_players rp where rp.profile_id = p.id)
      -- rooms.host_id and rooms.winner_id are ON DELETE NO ACTION, not cascade: a delete that
      -- hits one of these ERRORS. Since this sweep runs inside create_room's transaction, that
      -- would turn a storage nicety into "nobody can create a room". Exclude, don't tolerate.
      and not exists (select 1 from public.rooms r where r.host_id = p.id or r.winner_id = p.id)
    order by p.created_at
    limit greatest(p_limit, 0)
  ) c;

  if v_ids is null then
    return 0;
  end if;

  -- auth.refresh_tokens has NO foreign key to auth.users — it reaches them only through
  -- session_id -> auth.sessions -> auth.users (both cascading). A row whose session_id is null
  -- would therefore be orphaned by the delete below, so clear them by user_id first.
  --
  -- The ::text[] cast is load-bearing, and is the reason that column has no FK in the first
  -- place: GoTrue declares auth.refresh_tokens.user_id as character varying, not uuid (unlike
  -- auth.sessions.user_id and auth.identities.user_id, which are both real uuids). Without the
  -- cast this raises 42883 "operator does not exist: character varying = uuid".
  delete from auth.refresh_tokens where user_id = any(v_ids::text[]);

  -- auth.flow_state is the other FK-less identity reference, and it carries TWO of them:
  -- user_id, and linking_target_id — the latter written specifically by linkIdentity, i.e. by
  -- this project's own guest-upgrade flow. Neither would be cleaned by the cascade below, nor
  -- (for what it's worth) by auth.admin.deleteUser. Rows here are short-lived PKCE/OAuth
  -- handshake state, so in practice this clears a handful at most.
  delete from auth.flow_state where user_id = any(v_ids) or linking_target_id = any(v_ids);

  -- Cascades onward to everything that DOES have a foreign key, which is everything else:
  --   auth.users -> auth.identities, auth.sessions (-> auth.refresh_tokens by session_id),
  --                 auth.mfa_factors, auth.one_time_tokens, auth.oauth_authorizations,
  --                 auth.oauth_consents, auth.webauthn_challenges, auth.webauthn_credentials,
  --                 public.profiles
  --   public.profiles -> achievements, profile_stats, dictionary_presets, room_players,
  --                      custom_word_sets -> public.words (by custom_set_id)
  -- That last hop matters: a guest's custom dictionary WORDS go with their sets automatically.
  -- The only thing left behind anywhere is auth.audit_log_entries, which has no user column at
  -- all (identity lives inside its payload jsonb) and which auth.admin.deleteUser does not
  -- clean either — it's GoTrue's own append-only log, not application data.
  delete from auth.users where id = any(v_ids);
  get diagnostics v_deleted = row_count;
  return v_deleted;
exception when others then
  -- This runs inside create_room's transaction. Deleting from the auth schema depends on
  -- privileges this function's owner holds today but that a future Supabase platform change
  -- could revoke — and if that ever happens, the correct outcome is "guests stop being swept",
  -- not "nobody can start a game". Swallow, complain in the logs, report -1 so a caller that
  -- cares can tell a skipped sweep from an empty one.
  raise warning '_sweep_stale_guests skipped: % (SQLSTATE %)', sqlerrm, sqlstate;
  return -1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Hook it into the existing opportunistic sweep.
-- ---------------------------------------------------------------------------

-- Restated verbatim from 20260728000006 except for the trailing guest sweep. Kept short on
-- purpose so this copy stays reviewable against the original.
create or replace function public._sweep_stale_rooms()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  -- 24h is deliberately generous: a game runs for minutes, so anything a day old is abandoned
  -- beyond doubt. room_players and room_events cascade from this delete.
  delete from public.rooms
  where coalesce(finished_at, started_at, created_at) < now() - interval '24 hours';
  get diagnostics v_deleted = row_count;

  -- After the rooms, not before: a guest whose only tie to the world was an abandoned room
  -- becomes sweepable the moment that room is gone, so this ordering collects them a full cycle
  -- earlier instead of waiting for the next create_room.
  perform public._sweep_stale_guests();

  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. Internal helper: same lockdown as _sweep_stale_rooms.
-- ---------------------------------------------------------------------------

do $$
begin
  execute 'revoke all on function public._sweep_stale_guests(int) from public, anon, authenticated';
  execute 'grant execute on function public._sweep_stale_guests(int) to service_role';
end;
$$;
