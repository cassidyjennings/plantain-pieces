-- Xtina mode — roles and the arming toggle.
--
-- Two accounts matter: the OWNER (may arm the mode) and the PARTNER (the script targets them).
-- Both are assigned by hand in the SQL editor against real profile UUIDs; deliberately no UUID
-- is committed to the repo and no UI lists or selects users.
--
-- Neither role can be a guest: an anonymous auth.users row is created fresh per session, so a
-- role set on one would evaporate on the next visit. Assign roles only to OAuth-linked accounts.

alter table public.profiles
  add column if not exists xtina_role text
    check (xtina_role in ('owner', 'partner')),
  add column if not exists xtina_enabled boolean not null default false;

comment on column public.profiles.xtina_role is
  'owner = may arm xtina mode; partner = the account the scripted deal targets. NULL for everyone else.';
comment on column public.profiles.xtina_enabled is
  'Whether xtina mode is armed. Only meaningful on the owner row.';

-- rooms.mode gains a third value. The column was created with an inline check in
-- 20260721000001, so the constraint has to be dropped by its generated name and rebuilt.
alter table public.rooms drop constraint if exists rooms_mode_check;
alter table public.rooms
  add constraint rooms_mode_check check (mode in ('multiplayer', 'solo', 'xtina'));

-- ---------------------------------------------------------------------------
-- set_xtina_enabled — the on/off button. Owner-only; the role check is the whole point of the
-- function existing rather than opening profiles.xtina_enabled to a client write.
-- ---------------------------------------------------------------------------
create or replace function public.set_xtina_enabled(p_profile uuid, p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  select xtina_role into v_role from public.profiles where id = p_profile;
  if v_role is distinct from 'owner' then
    raise exception 'NOT_XTINA_OWNER' using errcode = 'P0001';
  end if;

  update public.profiles set xtina_enabled = p_on where id = p_profile;
  return jsonb_build_object('ok', true, 'enabled', p_on);
end;
$$;

-- Worker (service_role) only, same lockdown as every other action RPC.
do $$
begin
  execute 'revoke all on function public.set_xtina_enabled(uuid,boolean) from public, anon, authenticated';
  execute 'grant execute on function public.set_xtina_enabled(uuid,boolean) to service_role';
end $$;
