-- Account deletion cleanup. Deleting an auth user cascades to profiles and everything
-- FK'd with ON DELETE CASCADE / SET NULL (stats, achievements, game_players, custom sets,
-- presets, and games.winner_id). The one thing that BLOCKS it is the ephemeral `rooms`
-- table: rooms.host_id (not null, no cascade) and rooms.winner_id (no action) can still
-- reference a departing user via a lobby/finished room that hasn't been cleaned up yet.
-- This RPC clears those references so the subsequent auth.admin.deleteUser can proceed.
create or replace function public.prepare_account_deletion(p_profile uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Drop any live-room win reference on rooms this user did NOT host.
  update public.rooms set winner_id = null where winner_id = p_profile;
  -- Delete rooms this user hosts (cascades room_players + room_events). Other members
  -- lose the room, which is acceptable when the host is deleting their account.
  delete from public.rooms where host_id = p_profile;
  -- Their room_players rows in other people's rooms cascade-delete with the auth user.
  return jsonb_build_object('ok', true);
end;
$$;

do $$
begin
  execute 'revoke all on function public.prepare_account_deletion(uuid) from public, anon, authenticated';
  execute 'grant execute on function public.prepare_account_deletion(uuid) to service_role';
end $$;
