-- Xtina mode — the scripted Bunch and deal.
--
-- start_game and peel are replaced with BYTE-IDENTICAL signatures. Changing the argument types
-- would register a second overload alongside the original and make named-argument .rpc() calls
-- ambiguous ("function is not unique"); create-or-replace also preserves the existing
-- service_role-only grants, so no re-lockdown is needed for those two.

-- ---------------------------------------------------------------------------
-- The script. Twin of packages/shared/src/xtina.ts — keep both in sync; scripts/smoke-xtina.mjs
-- asserts they agree. A CASE rather than a 2-D array literal: PostgreSQL rejects
-- array[array[...], array[...]] when the inner arrays have different lengths.
-- ---------------------------------------------------------------------------
create or replace function public._xtina_step_letters(p_step int)
returns text[]
language sql
immutable
as $$
  select case p_step
    when 1  then array['Y','O','U','R','E']                          -- YOURE
    when 2  then array['B','E','A','T','I','F','U','L']              -- BEAUTIFUL (U shared)
    when 3  then array['N','T','E','L','L','I','G','E','N','T']      -- INTELLIGENT (I shared)
    when 4  then array['C','A','R','I','G']                          -- CARING (N shared)
    when 5  then array['S','T','O','N','G']                          -- STRONG (R shared)
    when 6  then array['H','I','A','R','I','O','U','S']              -- HILARIOUS (L shared)
    when 7  then array['P','E','C','I','A','L']                      -- SPECIAL (S shared)
    when 8  then array['D','R','V','E','N']                          -- DRIVEN (I shared)
    when 9  then array['M']                                          -- MY (Y shared)
    when 10 then array['O','V','E']                                  -- LOVE (L shared)
  end;
$$;

-- The owner's tiles for the whole game, in draw order: indices 1..5 at Split, 6..14 one per Peel.
create or replace function public._xtina_owner_tile(p_index int)
returns text
language sql
immutable
as $$
  select (array['X','Z','X','Z','X','Z','X','Z','X','Z','X','Z','X','Z'])[p_index];
$$;

-- 70 tiles: 56 for the partner (the ten words) + 14 for the owner (X/Z). Sized so bunch_count
-- reaches exactly 0 as LOVE's letters are dealt — peel requires bunch_count >= 2 and finish_game
-- requires bunch_count < 2, so this is arithmetic, not a tunable.
create or replace function public._xtina_bunch()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'A', 4, 'B', 1, 'C', 2, 'D', 1, 'E', 7, 'F', 1, 'G', 3, 'H', 1,
    'I', 6, 'L', 4, 'M', 1, 'N', 4, 'O', 4, 'P', 1, 'R', 4, 'S', 2,
    'T', 4, 'U', 3, 'V', 2, 'Y', 1,
    'X', 7, 'Z', 7
  );
$$;

-- Remove named letters from the Bunch. Deliberately NOT _draw_from_bunch, which draws at random —
-- the whole point here is that the deal is deterministic.
create or replace function public._xtina_take(p_room_id uuid, p_letters text[])
returns void
language plpgsql
as $$
declare
  v_bunch jsonb;
  v_letter text;
  v_have int;
begin
  select bunch into v_bunch from public.rooms where id = p_room_id;
  foreach v_letter in array p_letters loop
    v_have := coalesce((v_bunch ->> v_letter)::int, 0);
    if v_have < 1 then
      raise exception 'XTINA_BUNCH_DESYNC' using errcode = 'P0001';
    end if;
    v_bunch := jsonb_set(v_bunch, array[v_letter], to_jsonb(v_have - 1));
  end loop;
  update public.rooms
    set bunch = v_bunch,
        bunch_count = bunch_count - coalesce(array_length(p_letters, 1), 0)
    where id = p_room_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- start_game — identical to 20260728000003 (the current production body: 20260720000002's
-- solo-play relax, plus 20260728000003's remaining_count reset on every fresh deal) except for
-- the xtina branch. Falls through to the ordinary random deal unless ALL of: host is an armed
-- owner, exactly two non-spectators, and the other one is the partner.
-- ---------------------------------------------------------------------------
create or replace function public.start_game(p_room_id uuid, p_host uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_players int;
  v_deal int;
  v_player record;
  v_tiles text[];
  v_armed boolean;
  v_partner uuid;
  v_i int;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_room.host_id <> p_host then raise exception 'NOT_HOST' using errcode = 'P0001'; end if;
  if v_room.status <> 'lobby' then raise exception 'ALREADY_STARTED' using errcode = 'P0001'; end if;

  select count(*) into v_players
    from public.room_players where room_id = p_room_id and not is_spectator;
  if v_players < 1 then raise exception 'NEED_ONE_PLAYER' using errcode = 'P0001'; end if;

  select (xtina_role = 'owner' and xtina_enabled) into v_armed
    from public.profiles where id = p_host;

  if coalesce(v_armed, false) and v_players = 2 then
    select rp.profile_id into v_partner
      from public.room_players rp
      join public.profiles p on p.id = rp.profile_id
     where rp.room_id = p_room_id and not rp.is_spectator
       and rp.profile_id <> p_host and p.xtina_role = 'partner';
  end if;

  if v_partner is not null then
    -- Scripted path. Seed the exact Bunch, deal word 1 to the partner and junk to the owner.
    update public.rooms
      set bunch = public._xtina_bunch(),
          bunch_count = 70,
          mode = 'xtina',
          mode_config = jsonb_build_object('partnerId', v_partner, 'step', 1)
      where id = p_room_id;

    v_tiles := public._xtina_step_letters(1);
    perform public._xtina_take(p_room_id, v_tiles);
    update public.room_players
      set rack = to_jsonb(v_tiles), tile_count = array_length(v_tiles, 1), grid_state = '{}'::jsonb,
          remaining_count = null
      where room_id = p_room_id and profile_id = v_partner;

    v_tiles := array[]::text[];
    for v_i in 1..5 loop
      v_tiles := v_tiles || public._xtina_owner_tile(v_i);
    end loop;
    perform public._xtina_take(p_room_id, v_tiles);
    update public.room_players
      set rack = to_jsonb(v_tiles), tile_count = array_length(v_tiles, 1), grid_state = '{}'::jsonb,
          remaining_count = null
      where room_id = p_room_id and profile_id = p_host;

    v_deal := 5;
  else
    v_deal := public._initial_deal(v_players);

    for v_player in
      select profile_id from public.room_players
      where room_id = p_room_id and not is_spectator order by seat
    loop
      v_tiles := public._draw_from_bunch(p_room_id, v_deal);
      update public.room_players
        set rack = to_jsonb(v_tiles), tile_count = array_length(v_tiles, 1), grid_state = '{}'::jsonb,
            remaining_count = null
        where room_id = p_room_id and profile_id = v_player.profile_id;
    end loop;
  end if;

  update public.rooms set status = 'active', started_at = now() where id = p_room_id;

  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'game_started',
          jsonb_build_object('dealt', v_deal,
                             'bunchCount', (select bunch_count from public.rooms where id = p_room_id),
                             'tileCounts', public._tile_counts(p_room_id)));

  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- peel — identical to 20260706000002 except for the xtina branch. The stale-peel guard
-- (p_expected_count) and the BUNCH_TOO_LOW gate are untouched and still apply.
-- ---------------------------------------------------------------------------
create or replace function public.peel(p_room_id uuid, p_profile uuid, p_expected_count int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_active int;
  v_caller public.room_players;
  v_player record;
  v_tiles text[];
  v_new_rack jsonb;
  v_partner uuid;
  v_step int;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_room.status <> 'active' then raise exception 'GAME_NOT_ACTIVE' using errcode = 'P0001'; end if;

  select * into v_caller from public.room_players
    where room_id = p_room_id and profile_id = p_profile and not is_spectator;
  if not found then raise exception 'NOT_A_PLAYER' using errcode = 'P0001'; end if;
  if v_caller.tile_count <> p_expected_count then
    raise exception 'STALE_ACTION' using errcode = 'P0001';
  end if;

  select count(*) into v_active
    from public.room_players where room_id = p_room_id and not is_spectator;

  if v_room.bunch_count < v_active then
    raise exception 'BUNCH_TOO_LOW' using errcode = 'P0001';
  end if;

  if v_room.mode = 'xtina' then
    v_partner := (v_room.mode_config ->> 'partnerId')::uuid;
    v_step := (v_room.mode_config ->> 'step')::int + 1;
    if v_step > 10 then
      raise exception 'XTINA_SCRIPT_EXHAUSTED' using errcode = 'P0001';
    end if;

    -- Partner: the next word's letters.
    v_tiles := public._xtina_step_letters(v_step);
    perform public._xtina_take(p_room_id, v_tiles);
    update public.room_players rp
      set rack = rp.rack || to_jsonb(v_tiles),
          tile_count = rp.tile_count + coalesce(array_length(v_tiles, 1), 0)
      where rp.room_id = p_room_id and rp.profile_id = v_partner;

    -- Owner: one more junk tile. Index 5 was the last dealt at Split, so step 2 draws index 6.
    v_tiles := array[public._xtina_owner_tile(4 + v_step)];
    perform public._xtina_take(p_room_id, v_tiles);
    update public.room_players rp
      set rack = rp.rack || to_jsonb(v_tiles),
          tile_count = rp.tile_count + 1
      where rp.room_id = p_room_id and rp.profile_id = v_room.host_id;

    update public.rooms
      set mode_config = jsonb_set(mode_config, '{step}', to_jsonb(v_step))
      where id = p_room_id;
  else
    for v_player in
      select profile_id from public.room_players
      where room_id = p_room_id and not is_spectator order by seat
    loop
      v_tiles := public._draw_from_bunch(p_room_id, 1);
      update public.room_players rp
        set rack = rp.rack || to_jsonb(v_tiles),
            tile_count = rp.tile_count + coalesce(array_length(v_tiles, 1), 0)
        where rp.room_id = p_room_id and rp.profile_id = v_player.profile_id;
    end loop;
  end if;

  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'peel',
          jsonb_build_object('actor', p_profile,
                             'bunchCount', (select bunch_count from public.rooms where id = p_room_id),
                             'tileCounts', public._tile_counts(p_room_id)));

  select rack into v_new_rack from public.room_players
    where room_id = p_room_id and profile_id = p_profile;
  return jsonb_build_object('ok', true, 'rack', v_new_rack,
                            'bunchCount', (select bunch_count from public.rooms where id = p_room_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- _archive_game_impl — the entire body of archive_game as of 20260728000006 (the current
-- production body), renamed and otherwise unchanged. archive_game itself becomes a thin wrapper
-- below so an xtina game can early-return without touching lifetime stats.
-- ---------------------------------------------------------------------------
create or replace function public._archive_game_impl(p_room_id uuid, p_winner uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_player_count int;
  v_split_at timestamptz;
  v_since timestamptz;
  v_min_tiles int;
  v_p record;
  v_peels int;
  v_dumps int;
  v_first_peel_at timestamptz;
  v_first_peel_ms int;
  v_is_winner boolean;
  v_is_choke boolean;
  v_game_date date;
  v_stat public.profile_stats;
  v_prof public.profiles;
  v_new_streak int;
  v_nail_biter boolean;
  v_agg_games int;
  v_agg_peels int;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;

  -- Idempotency now lives on the room itself: stats_applied marks that this room's server-side
  -- rollup already happened. (It replaces the old "does a games row exist?" check, which is
  -- gone along with the table.) A rematch clears it, so game 2 in the same room rolls up again.
  if v_room.stats_applied then
    return jsonb_build_object('ok', true, 'roomId', p_room_id, 'alreadyApplied', true);
  end if;

  v_since := coalesce(v_room.started_at, '-infinity'::timestamptz);

  select count(*) into v_player_count
    from public.room_players where room_id = p_room_id and not is_spectator;

  select min(created_at) into v_split_at
    from public.room_events
    where room_id = p_room_id and type = 'game_started' and created_at >= v_since;

  select min(final_tiles) into v_min_tiles from (
    select tile_count as final_tiles from public.room_players
    where room_id = p_room_id and not is_spectator and profile_id <> p_winner
  ) s;

  select exists (
    select 1 from public.room_events e
    where e.room_id = p_room_id
      and e.type = 'plantains_rejected'
      and coalesce(e.payload ->> 'actor', '') <> p_winner::text
      and e.created_at <= v_room.finished_at
      and e.created_at >= v_room.finished_at - interval '5 seconds'
  ) into v_nail_biter;

  v_game_date := coalesce(v_room.finished_at, now())::date;

  for v_p in
    select profile_id, tile_count
    from public.room_players
    where room_id = p_room_id and not is_spectator
    order by seat
  loop
    select count(*) into v_peels from public.room_events
      where room_id = p_room_id and type = 'peel'
        and payload ->> 'actor' = v_p.profile_id::text and created_at >= v_since;
    select count(*) into v_dumps from public.room_events
      where room_id = p_room_id and type = 'dump'
        and payload ->> 'actor' = v_p.profile_id::text and created_at >= v_since;
    select min(created_at) into v_first_peel_at from public.room_events
      where room_id = p_room_id and type = 'peel'
        and payload ->> 'actor' = v_p.profile_id::text and created_at >= v_since;
    v_first_peel_ms := case when v_first_peel_at is not null and v_split_at is not null
      then (extract(epoch from (v_first_peel_at - v_split_at)) * 1000)::int end;

    v_is_winner := v_p.profile_id = p_winner;
    v_is_choke := (not v_is_winner) and v_min_tiles is not null and v_p.tile_count = v_min_tiles;

    select * into v_stat from public.profile_stats
      where profile_id = v_p.profile_id and mode = v_room.mode;
    if not found then
      insert into public.profile_stats (
        profile_id, mode, games_played, games_won, total_peels, total_dumps,
        fastest_peel_ms, choke_count, updated_at
      ) values (
        v_p.profile_id, v_room.mode, 1, (v_is_winner)::int, v_peels, v_dumps,
        v_first_peel_ms, (v_is_choke)::int, now()
      );
    else
      update public.profile_stats set
        games_played = v_stat.games_played + 1,
        games_won = v_stat.games_won + (v_is_winner)::int,
        total_peels = v_stat.total_peels + v_peels,
        total_dumps = v_stat.total_dumps + v_dumps,
        fastest_peel_ms = least(
          coalesce(v_stat.fastest_peel_ms, 2147483647),
          coalesce(v_first_peel_ms, 2147483647)),
        choke_count = v_stat.choke_count + (v_is_choke)::int,
        updated_at = now()
      where profile_id = v_p.profile_id and mode = v_room.mode;
    end if;
    update public.profile_stats set fastest_peel_ms = null
      where profile_id = v_p.profile_id and mode = v_room.mode and fastest_peel_ms = 2147483647;

    -- Account-wide play streak (NOT per-mode — playing either mode keeps the same streak alive).
    select * into v_prof from public.profiles where id = v_p.profile_id;
    if v_prof.last_played_date = v_game_date then
      v_new_streak := v_prof.current_streak;
    elsif v_prof.last_played_date = v_game_date - 1 then
      v_new_streak := v_prof.current_streak + 1;
    else
      v_new_streak := 1;
    end if;
    update public.profiles set
      current_streak = v_new_streak,
      longest_streak = greatest(v_prof.longest_streak, v_new_streak),
      last_played_date = v_game_date
      where id = v_p.profile_id;

    -- Server-authoritative achievements. meta carries roomId now; gameId no longer exists.
    if v_first_peel_ms is not null and v_first_peel_ms <= 60000 then
      perform public._unlock_achievement(v_p.profile_id, 'speed_peeler', jsonb_build_object('roomId', p_room_id, 'ms', v_first_peel_ms));
    end if;
    if v_is_winner and v_p.tile_count >= 100 then
      perform public._unlock_achievement(v_p.profile_id, 'marathon_mind', jsonb_build_object('roomId', p_room_id, 'tiles', v_p.tile_count));
    end if;
    if v_is_winner and v_dumps = 0 then
      perform public._unlock_achievement(v_p.profile_id, 'no_dumps_given', jsonb_build_object('roomId', p_room_id));
    end if;
    if v_player_count >= 8 then
      perform public._unlock_achievement(v_p.profile_id, 'full_house', jsonb_build_object('roomId', p_room_id));
    end if;
    if v_is_winner and v_nail_biter then
      perform public._unlock_achievement(v_p.profile_id, 'nail_biter', jsonb_build_object('roomId', p_room_id));
    end if;
    -- Lifetime-threshold achievements are mode-agnostic — sum across the profile's mode rows.
    select coalesce(sum(games_played), 0), coalesce(sum(total_peels), 0)
      into v_agg_games, v_agg_peels
      from public.profile_stats where profile_id = v_p.profile_id;
    if v_agg_games >= 100 then
      perform public._unlock_achievement(v_p.profile_id, 'century_club', jsonb_build_object('games', v_agg_games));
    end if;
    if v_agg_peels >= 1000 then
      perform public._unlock_achievement(v_p.profile_id, 'peel_machine', jsonb_build_object('peels', v_agg_peels));
    end if;
  end loop;

  update public.rooms set stats_applied = true where id = p_room_id;

  return jsonb_build_object('ok', true, 'roomId', p_room_id, 'alreadyApplied', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- archive_game — an xtina game must not touch lifetime stats, the play streak, or achievements.
-- Marks the room applied so the Worker's normal call is a clean no-op rather than a repeated
-- attempt.
-- ---------------------------------------------------------------------------
create or replace function public.archive_game(p_room_id uuid, p_winner uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode text;
begin
  select mode into v_mode from public.rooms where id = p_room_id;
  if v_mode = 'xtina' then
    update public.rooms set stats_applied = true where id = p_room_id;
    return jsonb_build_object('ok', true, 'roomId', p_room_id, 'skipped', 'xtina');
  end if;
  return public._archive_game_impl(p_room_id, p_winner);
end;
$$;

do $$
begin
  execute 'revoke all on function public._archive_game_impl(uuid,uuid) from public, anon, authenticated';
  execute 'grant execute on function public._archive_game_impl(uuid,uuid) to service_role';
  execute 'revoke all on function public._xtina_take(uuid,text[]) from public, anon, authenticated';
  execute 'grant execute on function public._xtina_take(uuid,text[]) to service_role';
end $$;
