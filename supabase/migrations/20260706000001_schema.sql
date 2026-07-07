-- Plantain Pieces — core schema, views, RLS, realtime.
-- Authoritative game state lives here; all writes happen via SECURITY DEFINER RPCs
-- called by the Cloudflare Worker with the service_role key. Clients only ever READ,
-- gated by RLS, and receive live updates through the room_events table.

create extension if not exists citext;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- profiles (1:1 with auth.users; guests are anonymous auth users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Guest',
  is_guest boolean not null default true,
  created_at timestamptz not null default now()
);

-- Auto-create a profile row whenever an auth user (including anonymous) is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, is_guest, display_name)
  values (
    new.id,
    coalesce(new.is_anonymous, true),
    'Guest-' || substr(replace(new.id::text, '-', ''), 1, 4)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- rooms
-- ---------------------------------------------------------------------------
create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_id uuid not null references public.profiles (id),
  status text not null default 'lobby' check (status in ('lobby', 'active', 'finished')),
  dictionary_config jsonb not null default
    '{"minLength":2,"maxLength":null,"baseEnabled":true,"excludedTopics":[],"customSetIds":[]}'::jsonb,
  bunch jsonb not null default '{}'::jsonb,     -- letter -> remaining count
  bunch_count int not null default 0,
  winner_id uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- ---------------------------------------------------------------------------
-- room_players
--   rack       = the player's FULL tile inventory (letters they own, placed or not).
--   grid_state = last persisted grid, for reconnect only (authoritative validation
--                uses the grid submitted with the peel/plantains action).
--   tile_count = jsonb_array_length(rack); the only publicly-visible per-player number.
-- ---------------------------------------------------------------------------
create table public.room_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  display_name text not null,
  seat int not null,
  is_ready boolean not null default false,
  is_spectator boolean not null default false,
  tile_count int not null default 0,
  rack jsonb not null default '[]'::jsonb,
  grid_state jsonb not null default '{}'::jsonb,
  connected boolean not null default true,
  joined_at timestamptz not null default now(),
  unique (room_id, profile_id),
  unique (room_id, seat)
);
create index room_players_room_idx on public.room_players (room_id);

-- ---------------------------------------------------------------------------
-- room_events — append-only public fan-out log (realtime source of truth).
-- Payloads carry ONLY public-safe data (bag count, per-player tile counts, actor).
-- ---------------------------------------------------------------------------
create table public.room_events (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms (id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index room_events_room_idx on public.room_events (room_id, id);

-- ---------------------------------------------------------------------------
-- custom word sets + words (base = ENABLE1 with null custom_set_id)
-- ---------------------------------------------------------------------------
create table public.custom_word_sets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.words (
  id bigint generated always as identity primary key,
  word citext not null,
  length int not null,
  topics text[] not null default '{}',
  custom_set_id uuid references public.custom_word_sets (id) on delete cascade
);
create unique index words_base_unique on public.words (word) where custom_set_id is null;
create unique index words_custom_unique on public.words (word, custom_set_id) where custom_set_id is not null;
create index words_length_idx on public.words (length);
create index words_topics_idx on public.words using gin (topics);
create index words_custom_set_idx on public.words (custom_set_id);

-- ---------------------------------------------------------------------------
-- friends + achievements (created now, feature work deferred to later phases)
-- ---------------------------------------------------------------------------
create table public.friends (
  user_id uuid not null references public.profiles (id) on delete cascade,
  friend_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'blocked')),
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id)
);

create table public.achievements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null,
  earned_at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- Membership helper (SECURITY DEFINER so it can read room_players from within
-- RLS policies / views without tripping row-level security recursively).
-- ---------------------------------------------------------------------------
create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.room_players
    where room_id = p_room_id and profile_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- Public views: expose only safe columns to room members.
-- security_invoker = false → view runs as owner and bypasses base-table RLS;
-- the WHERE clause (using auth.uid()) is what gates access.
-- ---------------------------------------------------------------------------
create view public.room_players_public
with (security_invoker = false) as
  select rp.room_id, rp.profile_id, rp.display_name, rp.seat,
         rp.is_ready, rp.is_spectator, rp.tile_count, rp.connected, rp.joined_at
  from public.room_players rp
  where public.is_room_member(rp.room_id);

create view public.rooms_public
with (security_invoker = false) as
  select r.id, r.code, r.host_id, r.status, r.dictionary_config,
         r.bunch_count, r.winner_id, r.created_at, r.started_at, r.finished_at
  from public.rooms r
  where public.is_room_member(r.id) or r.host_id = auth.uid();

grant select on public.room_players_public to authenticated, anon;
grant select on public.rooms_public to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Row-Level Security. Clients never write these tables directly (no INSERT/UPDATE
-- policies) — every mutation goes through the Worker + service_role, which bypasses RLS.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_players enable row level security;
alter table public.room_events enable row level security;
alter table public.custom_word_sets enable row level security;
alter table public.words enable row level security;
alter table public.friends enable row level security;
alter table public.achievements enable row level security;

-- profiles: display names are public; a user may update only their own.
create policy profiles_select_all on public.profiles
  for select to authenticated using (true);
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- room_players: a player can read only their own full row (rack/grid are private).
create policy room_players_select_own on public.room_players
  for select to authenticated using (profile_id = auth.uid());

-- room_events: any room member can read the fan-out log for their room.
create policy room_events_select_member on public.room_events
  for select to authenticated using (public.is_room_member(room_id));

-- rooms: no direct client SELECT (bunch contents must stay hidden). Use rooms_public.

-- words: base dictionary is world-readable (enables client-side pre-check features).
create policy words_select_all on public.words
  for select to authenticated, anon using (true);

-- custom_word_sets: owner-scoped.
create policy cws_select_own on public.custom_word_sets
  for select to authenticated using (owner_id = auth.uid());

-- friends / achievements: self-scoped reads (feature work later).
create policy friends_select_self on public.friends
  for select to authenticated using (user_id = auth.uid() or friend_id = auth.uid());
create policy achievements_select_self on public.achievements
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Realtime: clients subscribe to Postgres Changes on room_events (RLS-filtered).
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.room_events;
