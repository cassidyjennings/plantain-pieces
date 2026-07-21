-- Solo mode — schema. A player clears a Bunch alone; the room/game/stats pipeline is reused
-- unchanged (see the plan), tagged with a `mode` dimension so solo and multiplayer history and
-- lifetime stats can be told apart. The daily play-streak is deliberately account-wide (not
-- per-mode), so it moves off profile_stats onto profiles itself.

-- ---------------------------------------------------------------------------
-- rooms / games: a mode + mode_config (solo carries {bunchSize, timed}).
-- ---------------------------------------------------------------------------
alter table public.rooms
  add column mode text not null default 'multiplayer' check (mode in ('multiplayer', 'solo')),
  add column mode_config jsonb not null default '{}'::jsonb;

alter table public.games
  add column mode text not null default 'multiplayer' check (mode in ('multiplayer', 'solo')),
  add column mode_config jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- game_players: denormalized copy of games.mode (same style as display_name/opponents already
-- being snapshotted here), so per-mode queries don't need a join.
-- ---------------------------------------------------------------------------
alter table public.game_players
  add column mode text not null default 'multiplayer' check (mode in ('multiplayer', 'solo'));
create index game_players_profile_mode_idx on public.game_players (profile_id, mode, created_at desc);

-- ---------------------------------------------------------------------------
-- profile_stats: re-key from profile_id alone to (profile_id, mode). Existing rows backfill as
-- 'multiplayer' (the only mode that existed before this migration). The self-scoped RLS policy
-- (profile_stats_select_own) only predicates on profile_id, so it needs no change.
-- ---------------------------------------------------------------------------
alter table public.profile_stats drop constraint profile_stats_pkey;
alter table public.profile_stats
  add column mode text not null default 'multiplayer' check (mode in ('multiplayer', 'solo'));
alter table public.profile_stats add primary key (profile_id, mode);

-- Streak fields move OUT of profile_stats (mode-specific) onto profiles (account-wide).
alter table public.profile_stats
  drop column current_streak,
  drop column longest_streak,
  drop column last_played_date;

alter table public.profiles
  add column current_streak int not null default 0,
  add column longest_streak int not null default 0,
  add column last_played_date date;

-- ---------------------------------------------------------------------------
-- Views: expose the new columns.
-- ---------------------------------------------------------------------------
create or replace view public.rooms_public
with (security_invoker = false) as
  select r.id, r.code, r.host_id, r.status, r.dictionary_config,
         r.bunch_count, r.winner_id, r.created_at, r.started_at, r.finished_at,
         r.mode, r.mode_config
  from public.rooms r
  where public.is_room_member(r.id) or r.host_id = auth.uid();

create or replace view public.my_match_history
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
    g.duration_ms,
    gp.mode,
    g.mode_config
  from public.game_players gp
  join public.games g on g.id = gp.game_id
  where gp.profile_id = auth.uid();

-- ---------------------------------------------------------------------------
-- _scaled_bunch — proportional Bunch scaling via the largest-remainder method, mirroring
-- packages/shared/src/tiles.ts's scaledBunchDistribution() exactly (keep both in sync). At
-- p_bunch_size = 144 this reproduces _fresh_bunch() exactly with no rounding. A second pass
-- guarantees every letter has >= 1 tile once the bunch is large enough to fit the whole
-- alphabet (p_bunch_size >= 26), borrowing 1 tile at a time from whichever letter currently has
-- the most (never fires at 144, where the minimum is already 2).
--
-- Uses pure integer arithmetic (a remainder NUMERATOR over the common denominator 144, via
-- integer division/modulo) rather than a floating-point/numeric ratio — the latter was tried
-- first and broke: PostgreSQL's `numeric` division and JS's IEEE-754 doubles round a
-- non-terminating fraction like 96/144 = 2/3 to different decimal tails, so letters "tied" at
-- exactly 1/3 sorted in a different order here than in the shared TS version. Integer numerators
-- have no such ambiguity in either runtime.
-- ---------------------------------------------------------------------------
create or replace function public._scaled_bunch(p_bunch_size int)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_base jsonb := public._fresh_bunch();
  v_counts jsonb := '{}'::jsonb;
  v_remainders jsonb := '{}'::jsonb;
  v_floor_sum int := 0;
  v_remaining int;
  v_letters text[];
  v_letter text;
  v_richest text;
  v_richest_count int;
  v_rec record;
  v_rem_rec record;
  v_floor int;
  v_product int;
begin
  select array_agg(key order by key) into v_letters from jsonb_each_text(v_base);

  for v_rec in select key, value::int as base_count from jsonb_each_text(v_base) order by key loop
    v_product := v_rec.base_count * p_bunch_size;
    v_floor := v_product / 144;  -- integer division (truncating); exact for non-negative operands
    v_floor_sum := v_floor_sum + v_floor;
    v_counts := jsonb_set(v_counts, array[v_rec.key], to_jsonb(v_floor));
    v_remainders := jsonb_set(v_remainders, array[v_rec.key], to_jsonb(v_product - v_floor * 144));
  end loop;

  v_remaining := greatest(p_bunch_size - v_floor_sum, 0);

  for v_rem_rec in
    select key from jsonb_each_text(v_remainders)
    order by (value::text)::int desc, key asc
    limit v_remaining
  loop
    v_counts := jsonb_set(v_counts, array[v_rem_rec.key], to_jsonb((v_counts ->> v_rem_rec.key)::int + 1));
  end loop;

  if p_bunch_size >= array_length(v_letters, 1) then
    foreach v_letter in array v_letters loop
      if (v_counts ->> v_letter)::int > 0 then continue; end if;
      select key, (value::text)::int into v_richest, v_richest_count
        from jsonb_each_text(v_counts) order by (value::text)::int desc limit 1;
      v_counts := jsonb_set(v_counts, array[v_richest], to_jsonb(v_richest_count - 1));
      v_counts := jsonb_set(v_counts, array[v_letter], to_jsonb(1));
    end loop;
  end if;

  return v_counts;
end;
$$;
