-- Replace choke rate / alphabet letters with best peel streak / favorite starting letter on the
-- Stats tab. See docs/superpowers/specs/2026-08-08-stats-peel-streak-favorite-letter-design.md.

-- ---------------------------------------------------------------------------
-- 1. Schema: drop choke_count (nothing reads it once the tile is gone — no achievement depends
--    on it), add the two new lifetime fields.
-- ---------------------------------------------------------------------------
alter table public.profile_stats
  drop column choke_count,
  add column best_peel_streak int not null default 0,
  add column first_letter_counts jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 2. _merge_letter_counts — sums two per-letter frequency maps key-wise. Pure: no table access,
--    so it's directly testable with plain SELECTs.
-- ---------------------------------------------------------------------------
create or replace function public._merge_letter_counts(a jsonb, b jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_object_agg(k, coalesce((a ->> k)::int, 0) + coalesce((b ->> k)::int, 0)), '{}'::jsonb)
  from (
    select jsonb_object_keys(a) as k
    union
    select jsonb_object_keys(b) as k
  ) keys;
$$;

-- ---------------------------------------------------------------------------
-- 3. _best_peel_streak — longest run of consecutive 'peel' events for one profile in one room,
--    uninterrupted by a 'dump'. Standard gaps-and-islands: a running count of dumps seen so far
--    (window SUM ordered by time) is constant across a run of peels and increments at each dump,
--    so grouping peel rows by that running count clusters each unbroken run together; the largest
--    group is the longest streak.
-- ---------------------------------------------------------------------------
create or replace function public._best_peel_streak(p_room_id uuid, p_profile_id uuid, p_since timestamptz)
returns int
language sql
stable
as $$
  select coalesce(max(cnt), 0)
  from (
    select grp, count(*) as cnt
    from (
      select type,
             sum((type = 'dump')::int) over (order by created_at rows between unbounded preceding and current row) as grp
      from public.room_events
      where room_id = p_room_id
        and payload ->> 'actor' = p_profile_id::text
        and type in ('peel', 'dump')
        and created_at >= p_since
    ) tagged
    where type = 'peel'
    group by grp
  ) groups;
$$;

do $$
begin
  execute 'revoke all on function public._merge_letter_counts(jsonb,jsonb) from public, anon, authenticated';
  execute 'grant execute on function public._merge_letter_counts(jsonb,jsonb) to service_role';
  execute 'revoke all on function public._best_peel_streak(uuid,uuid,timestamptz) from public, anon, authenticated';
  execute 'grant execute on function public._best_peel_streak(uuid,uuid,timestamptz) to service_role';
end $$;
