# Daily Challenge Stats — Design

Date: 2026-09-24

## Problem

The Daily Puzzle (`daily_puzzles`, `create_daily_room`, `DailyPage.tsx`) is live, but its
"stats" are entirely client-side: `dailyStreak.ts` tracks streak/last-result in `localStorage`
only. There is no server record of a player's daily-puzzle completions, and no way to compare
one player's time against anyone else's.

The user wants, for the daily challenge specifically:
- Best time (personal best daily-puzzle completion)
- Average time (personal average across days played)
- Percentage of today's players you beat, recomputed live on every view
- Daily-specific breakdowns of stats that already exist generically: longest word, favorite
  starting letter

## Pre-existing bug found during investigation

`profile_stats_mode_check` (added in `20260808000001_fix_profile_stats_xtina_mode_check.sql`)
only allows `mode in ('multiplayer', 'solo', 'xtina')`. Every daily-room completion already
calls `archive_game` and (client-side) `submit_game_summary`, both of which try to
`insert`/`upsert` a `profile_stats` row with `mode = 'daily'`. That violates the check
constraint. The Worker calls these RPCs from an async fire-and-forget block with a swallowed
`catch`, so this has been failing silently: no daily game has ever recorded games_played,
longest word, or favorite starting letter into `profile_stats`.

This must be fixed as part of this work — the new stats depend on `profile_stats` accepting
`mode = 'daily'` rows, and it also means longest-word/favorite-letter "for free" once fixed,
since `profile_stats` is already keyed by `(profile_id, mode)`.

## Decisions (confirmed with user)

- **Best time** = personal best only (your fastest-ever daily solve), not a global leaderboard.
- **Average time** = mean of your own daily-solve durations across all days played.
- **Beat-%** = recomputed live every time it's viewed (not frozen at completion time), against
  everyone who has completed *today's* puzzle so far.
- **Placement**: Results page (right after solving) and the Profile Stats tab (as a new "Daily"
  mode filter, same pattern as the existing Solo/Multiplayer filters). Not added to the
  pre-solve Daily page — its streak block stays as-is.

## Schema changes

### 1. Fix `profile_stats_mode_check`

New migration, same shape as `20260808000001_fix_profile_stats_xtina_mode_check.sql`:

```sql
alter table public.profile_stats drop constraint profile_stats_mode_check;
alter table public.profile_stats
  add constraint profile_stats_mode_check check (mode in ('multiplayer', 'solo', 'xtina', 'daily'));
```

### 2. New table `daily_results`

Cross-player comparison needs a query shape ("everyone who played today's puzzle") that
`profile_stats` (profile-scoped) and `rooms` (swept after 24h idle, unindexed for this) can't
serve. One row per player per puzzle, written once at archive time.

```sql
create table public.daily_results (
  id           uuid primary key default gen_random_uuid(),
  puzzle_id    uuid not null references public.daily_puzzles(id),
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  duration_ms  int  not null,
  completed_at timestamptz not null default now(),
  unique (puzzle_id, profile_id)
);

alter table public.daily_results enable row level security;
-- No policy = deny all for anon/authenticated, same as daily_puzzles. All reads go through
-- the get_daily_result_summary RPC (aggregate only — no client ever sees another player's row).
```

Deliberately NOT swept by `_sweep_stale_rooms()` or the guest sweep's cascade path — this table
is keyed off `profiles`, not `rooms`, so a finished daily room can be reclaimed without losing
the result. (A swept *guest* profile's rows do cascade-delete via the `profile_id` FK, same as
every other guest-owned table — consistent with the existing "a guest's stats are not
protective" policy.)

### 3. `profile_stats` gains two columns

```sql
alter table public.profile_stats
  add column if not exists daily_best_time_ms  int    ,
  add column if not exists daily_total_time_ms bigint not null default 0;
```

Average is computed at read time as `daily_total_time_ms / games_played` (mode='daily') — no
stored average column, matching how `avg word length` is already computed from
`total_word_length / total_words` rather than stored.

## RPC / archive changes

### `_archive_game_impl` — new `mode = 'daily'` branch

Same shape and same loop position as the existing `solo_best_times` block (gated on
`v_room.mode = 'daily' and v_room.started_at is not null and v_room.finished_at is not null`;
daily rooms are single-player so the only way one finishes is the sole player winning, no
`v_is_winner` guard needed beyond that):

```sql
if v_room.mode = 'daily'
   and v_room.started_at is not null and v_room.finished_at is not null then
  v_duration_ms := greatest(0, (extract(epoch from (v_room.finished_at - v_room.started_at)) * 1000)::int);
  insert into public.daily_results (puzzle_id, profile_id, duration_ms)
  values ((v_room.mode_config ->> 'puzzleId')::uuid, v_p.profile_id, v_duration_ms)
  on conflict (puzzle_id, profile_id) do nothing;

  update public.profile_stats set
    daily_best_time_ms = least(coalesce(daily_best_time_ms, 2147483647), v_duration_ms),
    daily_total_time_ms = daily_total_time_ms + v_duration_ms
    where profile_id = v_p.profile_id and mode = 'daily';
  update public.profile_stats set daily_best_time_ms = null
    where profile_id = v_p.profile_id and mode = 'daily' and daily_best_time_ms = 2147483647;
end if;
```

The generic `insert`/`update` earlier in the same loop (games_played, games_won, longest word
via `submit_game_summary`, etc.) already handles `mode = 'daily'` once the check constraint is
fixed — this block only adds the two daily-only fields plus the `daily_results` row.

### New RPC: `get_daily_result_summary(p_puzzle_id uuid, p_profile_id uuid) returns jsonb`

Service-role only (revoked from `anon`/`authenticated`, same pattern as every other action RPC).

```sql
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
    'beatPercent', case when v_total > 1 then round(v_slower::numeric / (v_total - 1) * 100) else null end,
    'totalPlayersToday', v_total,
    'isPersonalBest', v_best_ms is not null and v_my_ms <= v_best_ms,
    'personalBestMs', v_best_ms
  );
end;
$$;
```

`beatPercent` is `null` when nobody else has played today yet (denominator would be zero) — the
client renders a "be the first!" style message in that case rather than "0%" or "100%".

## Worker

New route, alongside the existing `/daily/*` routes (already behind `requireAuth`):

```ts
app.get('/daily/:puzzleId/result-summary', async (c) => {
  const profileId = c.get('profileId');
  const puzzleId = c.req.param('puzzleId');
  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('get_daily_result_summary', {
    p_puzzle_id: puzzleId,
    p_profile_id: profileId,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});
```

## Client

### `lib/api.ts`
Add `getDailyResultSummary(puzzleId: string): Promise<DailyResultSummary>` calling the new
route. `DailyResultSummary` type mirrors the RPC's jsonb shape.

### `pages/Results.tsx`
New effect, `isDaily`-gated, following the same 400ms/1000ms retry pattern already used for
achievements and the board fetch (racing the same async `archive_game` write):

```ts
useEffect(() => {
  if (!room || room.mode !== 'daily' || room.status !== 'finished') return;
  const puzzleId = (room.mode_config as { puzzleId?: string }).puzzleId;
  if (!puzzleId) return;
  let cancelled = false;
  let latestSeq = 0;
  async function load() {
    const seq = ++latestSeq;
    const summary = await api.getDailyResultSummary(puzzleId!);
    if (cancelled || seq !== latestSeq) return;
    setDailySummary(summary);
  }
  load();
  const t = setTimeout(load, 1000);
  return () => { cancelled = true; clearTimeout(t); };
}, [room]);
```

Renders, in the existing daily results block:
- A stat tile: `Beat X% of today's players` (or "Be the first to solve today!" when
  `beatPercent` is null and `totalPlayersToday <= 1`).
- A small badge/line when `isPersonalBest` is true: "New personal best!".

Skeleton state while `dailySummary` is null, matching the existing skeleton pattern for the
other post-game stat tiles on this page.

### `lib/profile.ts`
- `GameMode` gains `'daily'`.
- `ProfileStatsRow` gains `daily_best_time_ms: number | null` and `daily_total_time_ms: number`.
- `aggregateStats` merges them across rows the same way `solo_best_times` is merged: min for
  `daily_best_time_ms`, sum for `daily_total_time_ms` (both default to "absent" cleanly since
  every non-daily row has `daily_total_time_ms = 0` and `daily_best_time_ms = null`).

### `pages/Profile.tsx` (`StatsBoard`)
- `filterOptions` gains `{ id: 'daily', label: 'Daily' }`.
- `showCompetitiveStats` becomes `filter !== 'solo' && filter !== 'daily'` (win rate and peel
  streak are meaningless for a single-player mode that always "wins" on completion — same
  reasoning already applied to solo).
- `Best time (daily)` tile, gated on `filter !== 'multiplayer' && filter !== 'solo'` (shown on
  `'all'` and `'daily'`, mirroring how `soloBestTimeTiles` already shows on `'all'` and
  `'solo'`) → `formatBestTime(stats.daily_best_time_ms ?? undefined)`. Min is associative
  regardless of which modes contributed to the merged `'all'` row, so this is safe to show
  there.
- `Average time (daily)` tile, gated on `filter === 'daily'` **only** (not shown on `'all'`).
  Reason: average requires dividing `daily_total_time_ms` by the *daily* game count
  specifically, but on the `'all'` (aggregate) view `stats.games_played` is summed across every
  mode — dividing by it there would silently produce a wrong number, not a missing one. Rather
  than add a shadow `daily_games_played` field purely to make one tile appear on one extra view,
  the average tile is simply daily-filter-only: `formatBestTime(stats.daily_total_time_ms / stats.games_played)`
  (safe on the `'daily'` filter view specifically, since that row's `games_played` already IS
  the daily count).

## Out of scope (flagged, not doing here)

- Syncing `dailyStreak.ts` off `localStorage` onto `daily_results` as the source of truth. This
  would fix a real cross-device gap (streak doesn't follow a linked account between devices) now
  that a server-side per-day record exists, but it wasn't asked for and is a separate, sizeable
  change (touches `isSolvedToday`/streak calculation, not just stats display). Worth a follow-up
  if wanted.
- A global "today's fastest" leaderboard stat — user confirmed best-time means personal-best
  only.

## Testing

- SQL-level: a scripted smoke test (matching the style of `scripts/smoke-guest-sweep.mjs`)
  covering: `daily_results` insert on archive, `on conflict do nothing` idempotency on a
  rematch-free room (`stats_applied` gate should prevent a second call from mattering anyway,
  but the `daily_results` unique constraint is defense-in-depth), `get_daily_result_summary`'s
  `beatPercent` math (0 other players → null; 1 slower of 2 others → correct rounding), and
  `isPersonalBest` on first-ever daily completion (best_ms was null beforehand).
- Typecheck + build for the client changes.
- Browser-verified per this repo's standing practice: play two daily rooms as two different
  guest profiles (via `npx supabase db reset` + manually seeding a `daily_puzzles` row, or
  whatever today's puzzle already is locally), confirm the second player's Results page shows a
  nonzero `beatPercent` and the Profile Stats "Daily" filter shows both times correctly.
