-- Relax display-name validation to allow special characters. The authoritative check is
-- the shared validateDisplayName() the Worker runs (now: length 1–20, reject only control
-- characters). This overrides update_profile's defense-in-depth blocklist to match — it
-- previously rejected punctuation/symbols, which is no longer wanted.
create or replace function public.update_profile(
  p_profile uuid, p_display_name text, p_avatar_config jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_slot text;
  v_allowed jsonb := jsonb_build_object(
    'base', jsonb_build_array('ripe','green','golden','speckled'),
    'hat', jsonb_build_array('none','straw','party','crown','beanie'),
    'glasses', jsonb_build_array('none','round','shades','star'),
    'hair', jsonb_build_array('none','swoop','curls','mohawk')
  );
  v_base text;
  v_row public.profiles;
begin
  if p_display_name is not null then
    v_name := trim(p_display_name);
    if char_length(v_name) < 1 then raise exception 'EMPTY' using errcode = 'P0001'; end if;
    if char_length(v_name) > 20 then raise exception 'TOO_LONG' using errcode = 'P0001'; end if;
    -- Special characters are allowed; only control characters are rejected.
    if v_name ~ '[[:cntrl:]]' then
      raise exception 'INVALID_CHARS' using errcode = 'P0001';
    end if;
    update public.profiles set display_name = v_name where id = p_profile;
  end if;

  if p_avatar_config is not null then
    v_base := p_avatar_config ->> 'base';
    if v_base is null or not (v_allowed -> 'base' ? v_base) then
      raise exception 'INVALID_AVATAR_CONFIG' using errcode = 'P0001';
    end if;
    foreach v_slot in array array['hat','glasses','hair'] loop
      if p_avatar_config ? v_slot and not (v_allowed -> v_slot ? (p_avatar_config ->> v_slot)) then
        raise exception 'INVALID_AVATAR_CONFIG' using errcode = 'P0001';
      end if;
    end loop;
    update public.profiles set avatar_config = p_avatar_config where id = p_profile;
  end if;

  select * into v_row from public.profiles where id = p_profile;
  if not found then raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'id', v_row.id, 'displayName', v_row.display_name,
    'isGuest', v_row.is_guest, 'avatarConfig', v_row.avatar_config
  );
end;
$$;

do $$
begin
  execute 'revoke all on function public.update_profile(uuid,text,jsonb) from public, anon, authenticated';
  execute 'grant execute on function public.update_profile(uuid,text,jsonb) to service_role';
end $$;
