-- Custom Dictionaries feature — CRUD for custom word sets and presets, plus
-- set_dictionary_config for the room host. All SECURITY DEFINER, called by the
-- Worker (service_role) only — never directly by clients via PostgREST.

-- ---------------------------------------------------------------------------
-- Internal helper: normalizes + validates a candidate DictionaryConfig.
-- Requires at least one word source enabled, sane length bounds, and every
-- referenced custom set to actually be owned by p_owner. Always returns
-- excludedTopics: [] regardless of input — the field is a stub until real
-- topic-tagged data exists, so we never persist a value for it.
-- ---------------------------------------------------------------------------
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
  v_owned_count int;
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
    'excludedTopics', '[]'::jsonb,
    'customSetIds', to_jsonb(v_custom_ids)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Custom word set CRUD
-- ---------------------------------------------------------------------------

create or replace function public.create_custom_word_set(p_owner uuid, p_name text, p_words text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_set_id uuid;
  v_words text[];
  v_existing_sets int;
begin
  v_name := trim(p_name);
  if v_name = '' or char_length(v_name) > 60 then
    raise exception 'INVALID_NAME' using errcode = 'P0001';
  end if;

  select count(*) into v_existing_sets from public.custom_word_sets where owner_id = p_owner;
  if v_existing_sets >= 30 then
    raise exception 'TOO_MANY_SETS' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct upper(trim(w))), '{}')
    into v_words
    from unnest(p_words) as w
    where upper(trim(w)) ~ '^[A-Z]{2,20}$';

  if coalesce(array_length(v_words, 1), 0) = 0 then
    raise exception 'INVALID_WORD_SET' using errcode = 'P0001';
  end if;
  if array_length(v_words, 1) > 2000 then
    raise exception 'TOO_MANY_WORDS' using errcode = 'P0001';
  end if;

  insert into public.custom_word_sets (owner_id, name) values (p_owner, v_name)
    returning id into v_set_id;

  insert into public.words (word, length, custom_set_id)
    select w, char_length(w), v_set_id from unnest(v_words) as w;

  return jsonb_build_object('id', v_set_id, 'name', v_name, 'wordCount', array_length(v_words, 1));
end;
$$;

-- Rename + full word-list replace (simpler mental model than incremental add/remove RPCs).
create or replace function public.update_custom_word_set(
  p_owner uuid, p_set_id uuid, p_name text, p_words text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_words text[];
begin
  -- NOT_FOUND covers both "doesn't exist" and "not yours" — deliberately not
  -- distinguished, so a client can't probe for the existence of other owners' sets.
  if not exists (select 1 from public.custom_word_sets where id = p_set_id and owner_id = p_owner) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  v_name := trim(p_name);
  if v_name = '' or char_length(v_name) > 60 then
    raise exception 'INVALID_NAME' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct upper(trim(w))), '{}')
    into v_words
    from unnest(p_words) as w
    where upper(trim(w)) ~ '^[A-Z]{2,20}$';

  if coalesce(array_length(v_words, 1), 0) = 0 then
    raise exception 'INVALID_WORD_SET' using errcode = 'P0001';
  end if;
  if array_length(v_words, 1) > 2000 then
    raise exception 'TOO_MANY_WORDS' using errcode = 'P0001';
  end if;

  update public.custom_word_sets set name = v_name where id = p_set_id;

  delete from public.words where custom_set_id = p_set_id;
  insert into public.words (word, length, custom_set_id)
    select w, char_length(w), p_set_id from unnest(v_words) as w;

  return jsonb_build_object('id', p_set_id, 'name', v_name, 'wordCount', array_length(v_words, 1));
end;
$$;

-- Words cascade via the existing custom_word_sets -> words FK (on delete cascade).
create or replace function public.delete_custom_word_set(p_owner uuid, p_set_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.custom_word_sets where id = p_set_id and owner_id = p_owner;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Dictionary presets — create-or-replace-by-name per owner.
-- ---------------------------------------------------------------------------

create or replace function public.save_dictionary_preset(p_owner uuid, p_name text, p_config jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_config jsonb;
  v_is_new boolean;
  v_count int;
  v_id uuid;
  v_created_at timestamptz;
begin
  v_name := trim(p_name);
  if v_name = '' or char_length(v_name) > 40 then
    raise exception 'INVALID_NAME' using errcode = 'P0001';
  end if;

  v_config := public._validate_dictionary_config(p_owner, p_config);

  v_is_new := not exists (
    select 1 from public.dictionary_presets where owner_id = p_owner and name = v_name
  );
  if v_is_new then
    select count(*) into v_count from public.dictionary_presets where owner_id = p_owner;
    if v_count >= 25 then
      raise exception 'TOO_MANY_PRESETS' using errcode = 'P0001';
    end if;
  end if;

  insert into public.dictionary_presets (owner_id, name, config)
  values (p_owner, v_name, v_config)
  on conflict (owner_id, name) do update set config = excluded.config
  returning id, created_at into v_id, v_created_at;

  return jsonb_build_object('id', v_id, 'name', v_name, 'config', v_config, 'createdAt', v_created_at);
end;
$$;

create or replace function public.delete_dictionary_preset(p_owner uuid, p_preset_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.dictionary_presets where id = p_preset_id and owner_id = p_owner;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Room-owner control: set the active DictionaryConfig for a room pre-Split.
-- Mirrors start_game's host-check + row-lock + lobby-only-status pattern.
-- ---------------------------------------------------------------------------
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
  if v_room.status <> 'lobby' then raise exception 'ALREADY_STARTED' using errcode = 'P0001'; end if;

  v_config := public._validate_dictionary_config(p_host, p_config);

  update public.rooms set dictionary_config = v_config where id = p_room_id;

  -- IDs only, no word content — safe to broadcast to every lobby member.
  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'dictionary_config_changed', jsonb_build_object('config', v_config));

  return jsonb_build_object('ok', true, 'config', v_config);
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock down: callable only by the Worker (service_role), never by clients
-- directly via PostgREST. Own block, separate from 20260706000002_rpcs.sql's —
-- that file is never edited once shipped.
-- ---------------------------------------------------------------------------
do $$
declare
  fn text;
  action_fns text[] := array[
    '_validate_dictionary_config(uuid,jsonb)',
    'create_custom_word_set(uuid,text,text[])',
    'update_custom_word_set(uuid,uuid,text,text[])',
    'delete_custom_word_set(uuid,uuid)',
    'save_dictionary_preset(uuid,text,jsonb)',
    'delete_dictionary_preset(uuid,uuid)',
    'set_dictionary_config(uuid,uuid,jsonb)'
  ];
begin
  foreach fn in array action_fns loop
    execute format('revoke all on function public.%s from public, anon, authenticated;', fn);
    execute format('grant execute on function public.%s to service_role;', fn);
  end loop;
end $$;
