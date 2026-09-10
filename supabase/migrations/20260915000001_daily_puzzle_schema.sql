-- Daily puzzle schema.
-- Answer keys (grid_state, letter_multiset) are service_role-only — RLS blocks all
-- authenticated reads so no player can peek at the solution before playing.

create table public.daily_puzzles (
  id                  uuid        primary key default gen_random_uuid(),
  language            text        not null,
  letter_multiset     text        not null,  -- flat "AAABBC..." string; converted at room creation
  grid_state          jsonb       not null,
  dictionary_config   jsonb       not null,
  floor_score         numeric     not null,
  spread_score        numeric     not null,
  mean_score          numeric,
  band                smallint,
  distinct_board_count integer    not null,
  replay_run_count    integer     not null,
  status              text        not null default 'available',
  scheduled_date      date,
  generation_seed     bigint      not null,
  first_word          text        not null,
  created_at          timestamptz not null default now(),
  constraint daily_puzzles_language_check
    check (language in ('en', 'es', 'fr', 'de')),
  constraint daily_puzzles_status_check
    check (status in ('available', 'scheduled', 'used', 'archived')),
  constraint daily_puzzles_band_check
    check (band is null or (band >= 1 and band <= 7))
);

alter table public.daily_puzzles enable row level security;
-- No policy = deny all for anon/authenticated. Service role bypasses RLS.
