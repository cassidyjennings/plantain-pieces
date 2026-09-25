-- Daily challenge stats — schema.
--
-- profile_stats_mode_check only allowed ('multiplayer', 'solo', 'xtina'). Every daily-room
-- completion already calls archive_game/submit_game_summary with mode = 'daily', which has been
-- silently failing the check constraint since the daily puzzle shipped (the Worker calls these
-- from an async fire-and-forget block with a swallowed catch — see
-- docs/superpowers/specs/2026-09-24-daily-challenge-stats-design.md). Fixing this also makes
-- longest_word/first_letter_counts correct for daily games "for free", since profile_stats is
-- already keyed by (profile_id, mode).
alter table public.profile_stats drop constraint profile_stats_mode_check;
alter table public.profile_stats
  add constraint profile_stats_mode_check check (mode in ('multiplayer', 'solo', 'xtina', 'daily'));

-- Personal best/average daily-puzzle completion time. Average is computed at read time as
-- daily_total_time_ms / games_played (mode='daily'), same convention as avg word length
-- (total_word_length / total_words) — no stored average column.
alter table public.profile_stats
  add column if not exists daily_best_time_ms  int,
  add column if not exists daily_total_time_ms bigint not null default 0;

-- ---------------------------------------------------------------------------
-- daily_results: one row per player per daily puzzle. This is the only way to compare one
-- player's time against everyone else's today — profile_stats is profile-scoped and rooms get
-- swept after 24h idle (see _sweep_stale_rooms), neither serves an "everyone who played today's
-- puzzle" query. Deny-all RLS, same pattern as daily_puzzles: all reads go through the
-- get_daily_result_summary RPC (aggregate numbers only — no client ever sees another player's
-- row). Cascades on profile deletion like every other guest-owned table (a swept guest's daily
-- results go with them, consistent with "a guest's stats are not protective").
-- ---------------------------------------------------------------------------
create table public.daily_results (
  id           uuid primary key default gen_random_uuid(),
  puzzle_id    uuid not null references public.daily_puzzles(id),
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  duration_ms  int  not null,
  completed_at timestamptz not null default now(),
  unique (puzzle_id, profile_id)
);

alter table public.daily_results enable row level security;
-- No policy = deny all for anon/authenticated. Service role bypasses RLS.
