-- Surface a player's avatar in the lobby/game. room_players snapshots avatar_config from
-- the joining profile via a trigger (create_room/join_room are shipped RPCs we don't edit),
-- and room_players_public exposes it so opponents can render each other's avatars.

alter table public.room_players
  add column avatar_config jsonb not null default '{}'::jsonb;

create or replace function public.set_room_player_avatar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select coalesce(avatar_config, '{}'::jsonb) into new.avatar_config
    from public.profiles where id = new.profile_id;
  if new.avatar_config is null then new.avatar_config := '{}'::jsonb; end if;
  return new;
end;
$$;

create trigger room_players_avatar_snapshot
  before insert on public.room_players
  for each row execute function public.set_room_player_avatar();

-- Append avatar_config to the public view (new column at the end — allowed by REPLACE).
create or replace view public.room_players_public
with (security_invoker = false) as
  select rp.room_id, rp.profile_id, rp.display_name, rp.seat,
         rp.is_ready, rp.is_spectator, rp.tile_count, rp.connected, rp.joined_at,
         rp.avatar_config
  from public.room_players rp
  where public.is_room_member(rp.room_id);
