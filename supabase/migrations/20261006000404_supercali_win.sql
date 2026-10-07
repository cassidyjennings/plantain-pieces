-- Phase 4 easter egg SUPERCALIFRAGILISTICEXPIALIDOCIOUS: validly on your board, it wins the game
-- instantly, in any mode, bypassing the bunch-low gate finish_game enforces.
--
-- The Worker (POST /rooms/:id/supercali) runs the shared validateSupercaliStructure and the
-- dictionary check first; this RPC re-checks the structural half authoritatively — the grid's
-- letters are a SUB-multiset of the caller's rack (other tiles may still be in hand), the grid is
-- one connected component (which, with >= 2 tiles, also rules out orphans), and SUPERCALI appears
-- as a whole word (a maximal horizontal or vertical run). Dictionary validity of the other words
-- stays in the Worker, exactly as for Plantains.
--
-- Like finish_game, this does NOT emit game_over: the Worker emits it after archive_game, flagged
-- {supercali: true}, so every client's Results page reads achievements that already exist.

create or replace function public._grid_cells(p_grid jsonb)
returns table (x int, y int, l text)
language sql
immutable
set search_path = public
as $$
  select split_part(e.key, ',', 1)::int, split_part(e.key, ',', 2)::int, upper(e.value)
  from jsonb_each_text(p_grid) e
$$;

create or replace function public.supercali_win(p_room_id uuid, p_profile uuid, p_grid jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_word constant text := 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS';
  v_len constant int := 34;
  v_room public.rooms;
  v_rp public.room_players;
  v_cells int;
  v_reached int;
  v_over boolean;
  v_has_word boolean;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_room.status <> 'active' then raise exception 'GAME_NOT_ACTIVE' using errcode = 'P0001'; end if;

  select * into v_rp from public.room_players
    where room_id = p_room_id and profile_id = p_profile and not is_spectator
    for update;
  if not found then raise exception 'NOT_IN_ROOM' using errcode = 'P0002'; end if;

  -- Shape: same rules as the shared isValidGridShape (key "x,y", single letter, <= 200 cells).
  if p_grid is null or jsonb_typeof(p_grid) <> 'object'
     or (select count(*) from jsonb_object_keys(p_grid)) > 200
     or exists (
       select 1 from jsonb_each(p_grid) e
       where e.key !~ '^-?\d{1,3},-?\d{1,3}$'
          or jsonb_typeof(e.value) <> 'string'
          or (e.value #>> '{}') !~ '^[A-Za-z]$'
     ) then
    raise exception 'MALFORMED_GRID' using errcode = 'P0001';
  end if;

  select count(*) into v_cells from public._grid_cells(p_grid);
  if v_cells < v_len then raise exception 'NO_SUPERCALI' using errcode = 'P0001'; end if;

  -- Sub-multiset: no letter used more times than the rack holds it.
  select exists (
    select 1
    from (select c.l, count(*) as n from public._grid_cells(p_grid) c group by c.l) g
    where g.n > (
      select count(*) from jsonb_array_elements_text(v_rp.rack) r where upper(r) = g.l
    )
  ) into v_over;
  if v_over then raise exception 'EXTRA_TILES' using errcode = 'P0001'; end if;

  -- Connectivity: flood fill from one cell; every cell must be reached.
  with recursive c as (
    select * from public._grid_cells(p_grid)
  ), reach (x, y) as (
    (select c.x, c.y from c order by c.y, c.x limit 1)
    union
    select c.x, c.y from reach r join c on abs(c.x - r.x) + abs(c.y - r.y) = 1
  )
  select count(*) into v_reached from reach;
  if v_reached <> v_cells then raise exception 'NOT_CONNECTED' using errcode = 'P0001'; end if;

  -- The word as a maximal run starting at some S: empty cell before it, empty cell after it, and
  -- the 34 cells between spell it (a gap makes string_agg shorter, so it can't match).
  with c as (select * from public._grid_cells(p_grid))
  select exists (
    select 1 from c s
    where s.l = 'S'
      and (
        (not exists (select 1 from c b where b.y = s.y and b.x = s.x - 1)
         and not exists (select 1 from c a where a.y = s.y and a.x = s.x + v_len)
         and (select string_agg(r.l, '' order by r.x) from c r
                where r.y = s.y and r.x between s.x and s.x + v_len - 1) = v_word)
        or
        (not exists (select 1 from c b where b.x = s.x and b.y = s.y - 1)
         and not exists (select 1 from c a where a.x = s.x and a.y = s.y + v_len)
         and (select string_agg(r.l, '' order by r.y) from c r
                where r.x = s.x and r.y between s.y and s.y + v_len - 1) = v_word)
      )
  ) into v_has_word;
  if not v_has_word then raise exception 'NO_SUPERCALI' using errcode = 'P0001'; end if;

  -- The board for the post-game viewer (what persist_grid would otherwise write).
  update public.room_players set grid_state = p_grid where id = v_rp.id;

  update public.rooms
    set status = 'finished', winner_id = p_profile, finished_at = now(), win_kind = 'supercali'
    where id = p_room_id;

  -- Mystery achievement. An xtina game never touches achievements (same rule as archive_game).
  if v_room.mode <> 'xtina' then
    perform public._unlock_achievement(p_profile, 'practically_perfect', jsonb_build_object('roomId', p_room_id));
  end if;

  return jsonb_build_object('ok', true, 'supercali', true);
end;
$$;

do $$
begin
  execute 'revoke all on function public._grid_cells(jsonb) from public, anon, authenticated';
  execute 'grant execute on function public._grid_cells(jsonb) to service_role';
  execute 'revoke all on function public.supercali_win(uuid,uuid,jsonb) from public, anon, authenticated';
  execute 'grant execute on function public.supercali_win(uuid,uuid,jsonb) to service_role';
end $$;
