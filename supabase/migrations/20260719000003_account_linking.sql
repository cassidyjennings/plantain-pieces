-- Account / Profile system — flip is_guest off when a real identity is linked.
--
-- Guests are anonymous auth users (no row in auth.identities). When a user upgrades
-- via linkIdentity({provider:'google'|'apple'}), Supabase inserts an auth.identities
-- row. This trigger clears profiles.is_guest for that user, DB-side, so guest status
-- is correct regardless of what the client does after the OAuth redirect.

create or replace function public.handle_identity_linked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.provider is distinct from 'anonymous' then
    update public.profiles set is_guest = false where id = new.user_id;
  end if;
  return new;
end;
$$;

create trigger on_auth_identity_linked
  after insert on auth.identities
  for each row execute function public.handle_identity_linked();
