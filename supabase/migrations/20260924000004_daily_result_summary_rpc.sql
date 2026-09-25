-- get_daily_result_summary: live "beat X% of today's players" comparison plus this player's
-- personal best/average daily time. Recomputed on every call (never cached/frozen) — per the
-- design doc, the percentage is meant to rise as more people finish later in the day.
-- Service-role only: no client ever selects daily_results directly.
create or replace function public.get_daily_result_summary(p_puzzle_id uuid, p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_my_ms int;
  v_total int;
  v_slower int;
  v_best_ms int;
begin
  select duration_ms into v_my_ms from public.daily_results
    where puzzle_id = p_puzzle_id and profile_id = p_profile_id;
  if not found then
    return jsonb_build_object('available', false);
  end if;

  select count(*) into v_total from public.daily_results where puzzle_id = p_puzzle_id;
  select count(*) into v_slower from public.daily_results
    where puzzle_id = p_puzzle_id and profile_id <> p_profile_id and duration_ms > v_my_ms;

  select daily_best_time_ms into v_best_ms from public.profile_stats
    where profile_id = p_profile_id and mode = 'daily';

  return jsonb_build_object(
    'available', true,
    'beatPercent', case when v_total > 1 then round(v_slower::numeric / (v_total - 1) * 100)::int else null end,
    'totalPlayersToday', v_total,
    'isPersonalBest', v_best_ms is not null and v_my_ms <= v_best_ms,
    'personalBestMs', v_best_ms
  );
end;
$$;

do $$
begin
  execute 'revoke all on function public.get_daily_result_summary(uuid,uuid) from public, anon, authenticated';
  execute 'grant execute on function public.get_daily_result_summary(uuid,uuid) to service_role';
end;
$$;
