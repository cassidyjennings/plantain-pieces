-- leave_room — a player exits a room (lobby, active game, or finished).
--   * Active game: the leaver's full tile inventory (rack = placed + unplaced)
--     returns to the Bunch so the remaining players' game stays winnable.
--   * Host handoff: if the host leaves, hostship passes to the next person who
--     joined after them (lowest seat greater than theirs; seats are join order),
--     wrapping to the earliest remaining seat. Seated players are preferred
--     over spectators.
--   * Last one out deletes the room (players/events cascade).

create or replace function public.leave_room(p_room_id uuid, p_profile uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_player public.room_players;
  v_new_host uuid;
  v_letter text;
  v_b jsonb;
  v_returned int;
  v_remaining int;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;

  select * into v_player from public.room_players
    where room_id = p_room_id and profile_id = p_profile;
  if not found then raise exception 'NOT_IN_ROOM' using errcode = 'P0002'; end if;

  if v_room.status = 'active' and not v_player.is_spectator then
    v_b := v_room.bunch;
    v_returned := coalesce(jsonb_array_length(v_player.rack), 0);
    for v_letter in select value from jsonb_array_elements_text(v_player.rack) loop
      v_b := jsonb_set(v_b, array[v_letter], to_jsonb(coalesce((v_b ->> v_letter)::int, 0) + 1));
    end loop;
    update public.rooms
      set bunch = v_b, bunch_count = bunch_count + v_returned
      where id = p_room_id;
  end if;

  delete from public.room_players where id = v_player.id;

  select count(*) into v_remaining from public.room_players where room_id = p_room_id;
  if v_remaining = 0 then
    delete from public.rooms where id = p_room_id;
    return jsonb_build_object('ok', true, 'roomDeleted', true);
  end if;

  if v_room.host_id = p_profile then
    -- "Next to join after them": lowest seat above the leaver's, else wrap to the
    -- earliest remaining seat. Prefer seated players; fall back to a spectator.
    select profile_id into v_new_host from public.room_players
      where room_id = p_room_id and not is_spectator and seat > v_player.seat
      order by seat limit 1;
    if v_new_host is null then
      select profile_id into v_new_host from public.room_players
        where room_id = p_room_id and not is_spectator order by seat limit 1;
    end if;
    if v_new_host is null then
      select profile_id into v_new_host from public.room_players
        where room_id = p_room_id order by seat limit 1;
    end if;
    update public.rooms set host_id = v_new_host where id = p_room_id;
  end if;

  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'player_left',
          jsonb_build_object('profileId', p_profile,
                             'displayName', v_player.display_name,
                             'newHostId', coalesce(v_new_host, v_room.host_id),
                             'bunchCount', (select bunch_count from public.rooms where id = p_room_id),
                             'tileCounts', public._tile_counts(p_room_id)));

  return jsonb_build_object('ok', true, 'newHostId', coalesce(v_new_host, v_room.host_id));
end;
$$;

do $$
begin
  execute 'revoke all on function public.leave_room(uuid,uuid) from public, anon, authenticated';
  execute 'grant execute on function public.leave_room(uuid,uuid) to service_role';
end $$;
