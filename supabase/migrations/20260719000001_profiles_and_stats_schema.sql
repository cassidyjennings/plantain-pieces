-- Account / Profile system — durable per-game history + lifetime stats rollup,
-- an avatar column on profiles, and the achievements uniqueness constraint.
--
-- Completed games are archived here (games + game_players) by archive_game so they
-- survive room teardown; profile_stats is the maintained lifetime rollup for a fast
-- profile load. All writes go through SECURITY DEFINER RPCs (service_role); clients
-- only READ, gated by RLS / owner-bypass views.

-- ---------------------------------------------------------------------------
-- Avatar customization on the existing profiles row.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column avatar_config jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- games — one row per completed game (durable; NOT deleted with the room).
-- ---------------------------------------------------------------------------
create table public.games (
  id uuid primary key default gen_random_uuid(),
  room_code text,
  winner_id uuid references public.profiles (id) on delete set null,
  player_count int not null,
  spectator_count int not null default 0,
  dictionary_config jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz not null default now(),
  duration_ms int,
  created_at timestamptz not null default now()
);
create index games_finished_idx on public.games (finished_at desc);

-- ---------------------------------------------------------------------------
-- game_players — one row per (game, player). Durable match history + the source
-- rows for stat rollups. `opponents` is a denormalized roster snapshot so match
-- history needs no cross-row reads (RLS keeps each player to their own rows).
-- Server-authoritative fields are filled by archive_game; the *_client fields
-- (final_placed_count, words_played, move_stats) come from the loosely-validated
-- client end-of-game summary via submit_game_summary.
-- ---------------------------------------------------------------------------
create table public.game_players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  seat int not null,
  display_name text not null,
  is_winner boolean not null default false,
  final_tile_count int not null default 0,
  final_placed_count int,                       -- client-reported
  peels int not null default 0,
  dumps int not null default 0,
  first_peel_ms int,                            -- ms from Split to this player's first peel
  longest_word text,                            -- client-reported
  words_played jsonb not null default '[]'::jsonb, -- client-reported
  rarest_word text,
  rarest_word_score int,
  move_stats jsonb not null default '{}'::jsonb, -- client-reported (peel eff / idle / dump regret)
  opponents jsonb not null default '[]'::jsonb,  -- [{profileId,displayName,seat,isWinner}]
  -- True once this player's client summary has been rolled into profile_stats. The
  -- word-stat rollup is applied once (first submission wins) so retries don't double-count;
  -- later submissions still refresh the descriptive columns above.
  summary_applied boolean not null default false,
  created_at timestamptz not null default now(),
  unique (game_id, profile_id)
);
create index game_players_profile_idx on public.game_players (profile_id, created_at desc);
create index game_players_game_idx on public.game_players (game_id);

-- ---------------------------------------------------------------------------
-- profile_stats — maintained lifetime rollup, 1:1 with profiles.
-- avg word length = total_word_length / nullif(total_words, 0).
-- first_letters = distinct starting letters played so far (for Alphabet Soup);
-- stored as a concatenation of uppercase letters, e.g. 'ACDT'.
-- ---------------------------------------------------------------------------
create table public.profile_stats (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  games_played int not null default 0,
  games_won int not null default 0,
  total_peels int not null default 0,
  total_dumps int not null default 0,
  total_words int not null default 0,
  total_word_length bigint not null default 0,
  longest_word text,
  longest_word_length int not null default 0,
  fastest_peel_ms int,
  rarest_word text,
  rarest_word_score int not null default 0,
  first_letters text not null default '',
  choke_count int not null default 0,
  current_streak int not null default 0,
  longest_streak int not null default 0,
  last_played_date date,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- achievements: unlock each type at most once per user. The table already exists
-- (created as a stub in the initial schema); add the uniqueness the upsert relies on.
-- ---------------------------------------------------------------------------
alter table public.achievements
  add constraint achievements_user_type_uniq unique (user_id, type);

-- ---------------------------------------------------------------------------
-- Membership helper for games RLS (mirrors is_room_member): true if the caller
-- has a game_players row in the game. SECURITY DEFINER to read game_players from
-- within an RLS policy without recursing.
-- ---------------------------------------------------------------------------
create or replace function public.is_game_participant(p_game_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.game_players
    where game_id = p_game_id and profile_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- RLS: self-scoped reads only. Clients never write these tables directly.
-- ---------------------------------------------------------------------------
alter table public.games enable row level security;
alter table public.game_players enable row level security;
alter table public.profile_stats enable row level security;

create policy games_select_participant on public.games
  for select to authenticated using (public.is_game_participant(id));

create policy game_players_select_own on public.game_players
  for select to authenticated using (profile_id = auth.uid());

create policy profile_stats_select_own on public.profile_stats
  for select to authenticated using (profile_id = auth.uid());

-- Base GRANTs (RLS is necessary but not sufficient on this CLI — see
-- 20260710000001_authenticated_grants.sql). service_role is covered by the
-- default-privileges set in 20260706000003, but we grant explicitly for clarity.
grant select on public.games to authenticated;
grant select on public.game_players to authenticated;
grant select on public.profile_stats to authenticated;
grant all privileges on public.games to service_role;
grant all privileges on public.game_players to service_role;
grant all privileges on public.profile_stats to service_role;

-- ---------------------------------------------------------------------------
-- my_match_history — owner-bypass view (security_invoker = false, gated by
-- auth.uid()) joining a player's own game_players rows to game metadata. Direct
-- RLS-readable by the client, same pattern as custom_word_sets_with_count.
-- ---------------------------------------------------------------------------
create view public.my_match_history
with (security_invoker = false) as
  select
    gp.id,
    gp.game_id,
    gp.profile_id,
    gp.is_winner,
    gp.seat,
    gp.final_tile_count,
    gp.final_placed_count,
    gp.peels,
    gp.dumps,
    gp.longest_word,
    gp.opponents,
    g.player_count,
    g.spectator_count,
    g.started_at,
    g.finished_at,
    g.duration_ms
  from public.game_players gp
  join public.games g on g.id = gp.game_id
  where gp.profile_id = auth.uid();

grant select on public.my_match_history to authenticated;
