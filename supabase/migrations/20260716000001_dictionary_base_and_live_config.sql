-- Wordlists gain an explicit **base** dictionary, and the host can retune the wordlist
-- during an active game (not just in the lobby).
--
-- A wordlist is one base + any number of additional dictionaries; the accepted words are the
-- union of all of them. The base is either the built-in ENABLE1 list (baseEnabled) or one of
-- the owner's custom sets (baseSetId). A custom base is ALSO kept in customSetIds, so
-- find_invalid_words' existing union needs no knowledge of bases and stays unchanged.

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
  v_base_set_id uuid;
  v_custom_ids uuid[];
  v_owned_count int;
begin
  v_min_len := coalesce((p_config ->> 'minLength')::int, 2);
  v_max_len := nullif(p_config ->> 'maxLength', 'null')::int;
  v_base_enabled := coalesce((p_config ->> 'baseEnabled')::boolean, true);

  begin
    v_base_set_id := nullif(p_config ->> 'baseSetId', 'null')::uuid;
  exception when invalid_text_representation then
    raise exception 'INVALID_CUSTOM_SET' using errcode = 'P0001';
  end;

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

  -- Normalize the two representations of a custom base against each other, so a caller can't
  -- persist a base that isn't actually part of the union deciding word validity.
  if v_base_set_id is not null then
    v_base_enabled := false;
    if not (v_base_set_id = any (v_custom_ids)) then
      v_custom_ids := array_append(v_custom_ids, v_base_set_id);
    end if;
  end if;

  if not v_base_enabled and coalesce(array_length(v_custom_ids, 1), 0) = 0 then
    raise exception 'NO_WORD_SOURCE' using errcode = 'P0001';
  end if;

  if coalesce(array_length(v_custom_ids, 1), 0) > 0 then
    select count(*) into v_owned_count
      from public.custom_word_sets
      where id = any (v_custom_ids) and owner_id = p_owner;
    if v_owned_count <> array_length(v_custom_ids, 1) then
      raise exception 'INVALID_CUSTOM_SET' using errcode = 'P0001';
    end if;
  end if;

  return jsonb_build_object(
    'minLength', v_min_len,
    'maxLength', v_max_len,
    'baseEnabled', v_base_enabled,
    'baseSetId', v_base_set_id,
    'excludedTopics', '[]'::jsonb,
    'customSetIds', to_jsonb(v_custom_ids)
  );
end;
$$;

-- The word-length stepper and "Choose Wordlist" now live in the in-game top bar, so the host
-- must be able to change the config mid-game. Only a finished game is off-limits.
create or replace function public.set_dictionary_config(p_room_id uuid, p_host uuid, p_config jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_config jsonb;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_room.host_id <> p_host then raise exception 'NOT_HOST' using errcode = 'P0001'; end if;
  if v_room.status not in ('lobby', 'active') then
    raise exception 'ALREADY_STARTED' using errcode = 'P0001';
  end if;

  v_config := public._validate_dictionary_config(p_host, p_config);

  update public.rooms set dictionary_config = v_config where id = p_room_id;

  -- IDs only, no word content — safe to broadcast to every player.
  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'dictionary_config_changed', jsonb_build_object('config', v_config));

  return jsonb_build_object('ok', true, 'config', v_config);
end;
$$;

-- CREATE OR REPLACE keeps existing privileges, but re-assert them so this migration is
-- self-contained if the functions are ever recreated from scratch.
do $$
declare
  fn text;
  action_fns text[] := array[
    '_validate_dictionary_config(uuid,jsonb)',
    'set_dictionary_config(uuid,uuid,jsonb)'
  ];
begin
  foreach fn in array action_fns loop
    execute format('revoke all on function public.%s from public, anon, authenticated;', fn);
    execute format('grant execute on function public.%s to service_role;', fn);
  end loop;
end $$;
