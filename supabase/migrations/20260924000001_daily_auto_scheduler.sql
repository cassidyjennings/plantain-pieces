-- Daily puzzle auto-scheduler.
--
-- Until now puzzles were moved from 'available' to 'scheduled' by hand, and only 14 days were
-- ever allocated (2026-09-10..23). On 2026-09-24 create_daily_room raised NO_DAILY_PUZZLE for
-- everyone even though ~470 puzzles sat unscheduled in the bank.
--
-- _schedule_daily_puzzles() keeps a rolling horizon filled: every unscheduled date from
-- yesterday (UTC) through today + p_days gets one puzzle. yesterday because create_daily_room
-- accepts the player's local date, which can be one day either side of the UTC date.
--
-- Band follows the day of the week, Mon = 1 (easiest) .. Sun = 7 (hardest), per the generation
-- spec. The first hand-scheduled fortnight used a scrambled mapping (Wed = 7, Sun = 1); those
-- dates are in the past and are left alone. When the target band is empty the nearest band is
-- used instead so a lopsided bank degrades difficulty slightly rather than causing an outage —
-- band 4 is the narrowest (floor_score 3.25..3.3333) and runs out first.
--
-- Runs daily via pg_cron with a 60-day horizon, so a missed or failing run leaves weeks of
-- slack. It warns (not raises) when the bank is empty so the cron log shows it.

create extension if not exists pg_cron with schema pg_catalog;

-- One puzzle per language per date. Every existing date has exactly one, so this is safe to add;
-- it also makes a concurrent double-run fail loudly instead of scheduling two puzzles for a day.
create unique index if not exists daily_puzzles_one_per_day_idx
  on public.daily_puzzles (language, scheduled_date)
  where status = 'scheduled';

create or replace function public._schedule_daily_puzzles(
  p_days     int  default 60,
  p_language text default 'en'
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today     date := (now() at time zone 'utc')::date;
  v_date      date;
  v_band      int;
  v_id        uuid;
  v_scheduled int := 0;
begin
  -- Serialize runs so two callers can't pick the same available row.
  perform pg_advisory_xact_lock(hashtext('schedule_daily_puzzles:' || p_language));

  for v_date in
    select d::date
    from   generate_series(v_today - 1, v_today + p_days, interval '1 day') d
    where  not exists (
             select 1 from public.daily_puzzles
             where  language = p_language
               and  scheduled_date = d::date
               and  status = 'scheduled')
    order  by d
  loop
    v_band := extract(isodow from v_date)::int;  -- Mon = 1 .. Sun = 7

    select id into v_id
    from   public.daily_puzzles
    where  status = 'available'
      and  language = p_language
    order  by band is null, abs(band - v_band), random()  -- unbanded rows only as a last resort
    limit  1
    for update skip locked;

    if v_id is null then
      raise warning 'daily puzzle bank empty for %: % left unscheduled onward', p_language, v_date;
      exit;
    end if;

    update public.daily_puzzles
    set    status = 'scheduled', scheduled_date = v_date
    where  id = v_id;

    v_scheduled := v_scheduled + 1;
  end loop;

  return v_scheduled;
end;
$$;

revoke all on function public._schedule_daily_puzzles(int, text) from public, anon, authenticated;
grant execute on function public._schedule_daily_puzzles(int, text) to service_role;

-- 00:05 UTC daily. cron.schedule upserts by job name, so re-running this migration is safe.
select cron.schedule(
  'schedule-daily-puzzles',
  '5 0 * * *',
  $$select public._schedule_daily_puzzles(60, 'en')$$
);

-- Fill the horizon immediately rather than waiting for the first cron tick.
select public._schedule_daily_puzzles(60, 'en');
