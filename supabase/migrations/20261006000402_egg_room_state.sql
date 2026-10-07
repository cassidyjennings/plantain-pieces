-- Phase 4 easter eggs: per-room egg state. Lives on the ROOM (room_players / rooms) so it dies with
-- the room and needs no cleanup of its own; rematch_room resets it for game 2.
--
--   room_players.ghosted     GHOST validly appeared on this player's board. Opponents then see the
--                            player's tile_count / remaining_count as NULL (rendered "??") for the
--                            rest of the game, even if the word is later broken (no un-ghost path).
--   room_players.freeze_used FREEZE fired in a Timed solo game; _archive_game_impl subtracts
--                            10000 ms from the duration (migration 20261006000403). Client-reported
--                            and spoofable — accepted (spec 4.1).
--   rooms.win_kind           'supercali' when the game ended via supercali_win (20261006000404);
--                            Results shows a special callout off it.

alter table public.room_players
  add column ghosted boolean not null default false,
  add column freeze_used boolean not null default false;

alter table public.rooms
  add column win_kind text check (win_kind in ('supercali'));

-- ---------------------------------------------------------------------------
-- room_players_public — counts masked for a ghosted player while the game is ACTIVE (a finished
-- room shows the real final numbers again). Same columns in the same order with two appended at
-- the end (replace-safe); joins rooms for the status, which security_invoker = false reads past RLS
-- exactly as it already reads room_players.
-- ---------------------------------------------------------------------------
create or replace view public.room_players_public
with (security_invoker = false) as
  select rp.room_id, rp.profile_id, rp.display_name, rp.seat,
         rp.is_ready, rp.is_spectator,
         case when rp.ghosted and r.status = 'active' then null else rp.tile_count end as tile_count,
         rp.connected, rp.joined_at,
         rp.avatar_config,
         case when rp.ghosted and r.status = 'active' then null else rp.remaining_count end as remaining_count,
         rp.ghosted, rp.freeze_used
  from public.room_players rp
  join public.rooms r on r.id = rp.room_id
  where public.is_room_member(rp.room_id);

-- rooms_public — append win_kind (replace-safe, new column at the end).
create or replace view public.rooms_public
with (security_invoker = false) as
  select r.id, r.code, r.host_id, r.status, r.dictionary_config,
         r.bunch_count, r.winner_id, r.created_at, r.started_at, r.finished_at,
         r.mode, r.mode_config, r.state_version, r.win_kind
  from public.rooms r
  where public.is_room_member(r.id) or r.host_id = auth.uid();

-- ---------------------------------------------------------------------------
-- report_egg_flags — a DEDICATED RPC rather than a new report_progress parameter: adding a param
-- to report_progress would create a second overload (CLAUDE.md). The Worker's existing
-- POST /rooms/:id/progress route calls this when the body carries flags.
--
-- Flags are one-way latches. GHOST broadcasts a 'progress' event (the type clients already refetch
-- the roster on) carrying only {profileId, ghosted} — no counts. FREEZE is accepted only for a
-- Timed solo room and broadcasts nothing (there is no one to tell).
-- ---------------------------------------------------------------------------
create or replace function public.report_egg_flags(p_room_id uuid, p_profile uuid, p_flags jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_rp public.room_players;
  v_flags jsonb := coalesce(p_flags, '{}'::jsonb);
  v_ghost boolean;
  v_freeze boolean;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_room.status <> 'active' then raise exception 'GAME_NOT_ACTIVE' using errcode = 'P0001'; end if;

  select * into v_rp from public.room_players
    where room_id = p_room_id and profile_id = p_profile
    for update;
  if not found then raise exception 'NOT_IN_ROOM' using errcode = 'P0002'; end if;

  -- jsonb equality, not a ::boolean cast: a non-boolean value is simply "not set", never a 22P02.
  v_ghost := (v_flags -> 'ghosted') = 'true'::jsonb;
  v_freeze := (v_flags -> 'freezeUsed') = 'true'::jsonb
              and v_room.mode = 'solo'
              and coalesce((v_room.mode_config ->> 'timed')::boolean, false);

  if v_ghost and not v_rp.ghosted then
    update public.room_players set ghosted = true where id = v_rp.id;
    insert into public.room_events (room_id, type, payload)
      values (p_room_id, 'progress', jsonb_build_object('profileId', p_profile, 'ghosted', true));
  end if;

  if v_freeze and not v_rp.freeze_used then
    update public.room_players set freeze_used = true where id = v_rp.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'ghosted', v_rp.ghosted or v_ghost,
    'freezeUsed', v_rp.freeze_used or v_freeze
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- rematch_room — verbatim from 20260728000006, plus the [phase4] resets.
-- ---------------------------------------------------------------------------
create or replace function public.rematch_room(p_room_id uuid, p_profile uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_is_member boolean;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;

  select exists (
    select 1 from public.room_players where room_id = p_room_id and profile_id = p_profile
  ) into v_is_member;
  if not v_is_member then raise exception 'NOT_IN_ROOM' using errcode = 'P0002'; end if;

  if v_room.mode <> 'multiplayer' then
    raise exception 'NOT_MULTIPLAYER' using errcode = 'P0001';
  end if;

  if v_room.status = 'lobby' then
    return jsonb_build_object('roomId', v_room.id, 'code', v_room.code, 'alreadyReset', true);
  end if;
  if v_room.status <> 'finished' then
    raise exception 'GAME_NOT_FINISHED' using errcode = 'P0001';
  end if;

  update public.rooms set
    status = 'lobby',
    winner_id = null,
    started_at = null,
    finished_at = null,
    bunch = public._fresh_bunch(),
    bunch_count = 144,
    stats_applied = false,
    win_kind = null              -- [phase4]
  where id = p_room_id;

  update public.room_players set
    rack = '[]'::jsonb,
    grid_state = '{}'::jsonb,
    tile_count = 0,
    is_ready = false,
    remaining_count = null,
    summary_applied = false,
    ghosted = false,             -- [phase4]
    freeze_used = false          -- [phase4]
  where room_id = p_room_id;

  delete from public.room_events where room_id = p_room_id;

  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'rematch',
          jsonb_build_object('actor', p_profile, 'roomId', p_room_id, 'code', v_room.code));

  return jsonb_build_object('roomId', v_room.id, 'code', v_room.code, 'alreadyReset', false);
end;
$$;

do $$
begin
  execute 'revoke all on function public.report_egg_flags(uuid,uuid,jsonb) from public, anon, authenticated';
  execute 'grant execute on function public.report_egg_flags(uuid,uuid,jsonb) to service_role';
end $$;
