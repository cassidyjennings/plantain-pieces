# Daily Challenge Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-authoritative daily-challenge stats — personal best time, personal average
time, and a live "beat X% of today's players" comparison — plus fix a pre-existing bug where
`mode = 'daily'` games have never actually written to `profile_stats` (so longest word / favorite
starting letter for daily games have never worked either).

**Architecture:** A new `daily_results` table (one row per player per puzzle, service-role-only)
backs the cross-player comparison; `profile_stats` gets two new scalar columns
(`daily_best_time_ms`, `daily_total_time_ms`) for the personal best/average, keyed the same way
every other per-mode stat already is (`profile_id, mode`). `_archive_game_impl` — the existing
SECURITY DEFINER function that rolls up stats after every game — gets one new `mode = 'daily'`
branch. A new SECURITY DEFINER RPC computes the live beat-percentage; a new Worker route exposes
it; the client fetches it on the Results page and surfaces best/average time as a new "Daily"
filter on the Profile Stats tab.

**Tech Stack:** Supabase Postgres (plpgsql SECURITY DEFINER functions + RLS), Cloudflare Worker
(Hono), React + TypeScript (Vite), `pg` (Node) for local smoke-testing migrations.

## Global Constraints

- Windows/PowerShell + Git Bash environment. `npm run db:start`/`db:reset` need Docker Desktop
  running; both self-heal a stale Docker socket automatically (see CLAUDE.md).
- Migrations must be applied in filename order — a skipped one fails LATER with a confusing
  error pointing at the wrong file. Run `npm run db:reset` after each new migration in this plan
  before moving to the next task.
- No client ever writes to game tables directly — all mutations go through a
  `SECURITY DEFINER` RPC called by the Cloudflare Worker (service role). `daily_results` follows
  this: it is deny-all RLS, read only via a new aggregate RPC, never selected directly by a
  client.
- Any button with a visibly "on" state must use the shared `.toggle-btn` class — not relevant to
  this plan (no new toggle buttons), noted for completeness per CLAUDE.md conventions.
- End every commit message with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- Design source: `docs/superpowers/specs/2026-09-24-daily-challenge-stats-design.md`.

---

### Task 1: Schema — `profile_stats` accepts `'daily'`, gains two columns; new `daily_results` table

**Files:**
- Create: `supabase/migrations/20260924000002_daily_stats_schema.sql`
- Create: `scripts/smoke-daily-stats.mjs`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `public.profile_stats.mode` now accepts `'daily'` (constraint `profile_stats_mode_check`).
  - `public.profile_stats.daily_best_time_ms int` (nullable, no default — same convention as
    `fastest_peel_ms`).
  - `public.profile_stats.daily_total_time_ms bigint not null default 0`.
  - `public.daily_results(id, puzzle_id, profile_id, duration_ms, completed_at)`, unique on
    `(puzzle_id, profile_id)`, RLS enabled with no policies (deny-all for anon/authenticated).
  - `scripts/smoke-daily-stats.mjs` — a Node smoke test script (same style as
    `scripts/smoke-stats-tiles.mjs`), run via `node scripts/smoke-daily-stats.mjs` against the
    local Supabase stack. Later tasks append to this same file.

- [ ] **Step 1: Write the failing smoke test**

Create `scripts/smoke-daily-stats.mjs`:

```js
// scripts/smoke-daily-stats.mjs
// Scripted smoke test for daily-challenge stats against the LOCAL supabase stack.
// Run from the repo root:  node scripts/smoke-daily-stats.mjs
import pg from 'pg';

const DB = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const client = new pg.Client({ connectionString: DB });

function assert(cond, label) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`  ok  ${label}`);
}

async function makeUser(email) {
  const { rows } = await client.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                             email_confirmed_at, created_at, updated_at,
                             raw_app_meta_data, raw_user_meta_data, is_anonymous)
     values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
             'authenticated', $1, '', now(), now(), now(), '{}', '{}', false)
     returning id`,
    [email],
  );
  return rows[0].id;
}

async function main() {
  await client.connect();
  console.log('profile_stats accepts mode = daily');

  const p1 = await makeUser(`daily1-${Date.now()}@example.test`);
  await client.query(`insert into public.profile_stats (profile_id, mode) values ($1, 'daily')`, [p1]);
  const row = (await client.query(
    `select daily_best_time_ms, daily_total_time_ms from public.profile_stats
       where profile_id = $1 and mode = 'daily'`,
    [p1],
  )).rows[0];
  assert(row.daily_best_time_ms === null, 'daily_best_time_ms defaults to null');
  assert(row.daily_total_time_ms === '0' || row.daily_total_time_ms === 0, 'daily_total_time_ms defaults to 0');

  console.log('\ndaily_results table');

  const fakePuzzleId = (await client.query(`select gen_random_uuid() as id`)).rows[0].id;
  // No FK-satisfying daily_puzzles row exists yet in this bare test — insert directly against a
  // throwaway puzzle_id to prove the table/unique-constraint shape alone (Task 2 exercises the
  // real create_daily_room -> archive_game path with a genuine daily_puzzles row).
  await client.query(
    `insert into public.daily_puzzles
       (language, letter_multiset, grid_state, dictionary_config, floor_score, spread_score,
        distinct_board_count, replay_run_count, status, scheduled_date, generation_seed, first_word)
     values ('en', 'AAAABBBBCCCCDDDDEEEEFFFF', '{}'::jsonb,
             '{"minLength":2,"maxLength":null,"baseEnabled":true,"excludedTopics":[],"customSetIds":[]}'::jsonb,
             1.0, 0.5, 1, 1, 'available', current_date + 30, 1, 'TEST')`,
  );
  await client.query(
    `insert into public.daily_results (puzzle_id, profile_id, duration_ms)
       select id, $1, 100000 from public.daily_puzzles where scheduled_date = current_date + 30`,
    [p1],
  );
  let dupeRejected = false;
  try {
    await client.query(
      `insert into public.daily_results (puzzle_id, profile_id, duration_ms)
         select id, $1, 200000 from public.daily_puzzles where scheduled_date = current_date + 30`,
      [p1],
    );
  } catch {
    dupeRejected = true;
  }
  assert(dupeRejected, 'unique(puzzle_id, profile_id) rejects a second row for the same player');

  console.log('\nAll smoke-daily-stats checks passed.');
  await client.end();
}

main().catch((err) => {
  console.error(err);
  client.end();
  process.exit(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
node scripts/smoke-daily-stats.mjs
```
Expected: FAIL — the insert with `mode = 'daily'` raises
`new row for relation "profile_stats" violates check constraint "profile_stats_mode_check"`
(the `daily_results` table doesn't exist yet either, but the script never gets that far).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260924000002_daily_stats_schema.sql`:

```sql
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
```

- [ ] **Step 4: Apply the migration and run the test again**

Run:
```bash
npm run db:reset
node scripts/smoke-daily-stats.mjs
```
Expected: `npm run db:reset` completes without error; the smoke script prints `ok` for both
checks and `All smoke-daily-stats checks passed.`

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260924000002_daily_stats_schema.sql scripts/smoke-daily-stats.mjs
git commit -m "$(cat <<'EOF'
fix(daily): allow profile_stats mode='daily', add daily_results table

profile_stats_mode_check never included 'daily', so every daily-room
completion has been silently failing to roll up stats. Also adds the
daily_best_time_ms/daily_total_time_ms columns and the daily_results
table the beat-percent comparison needs.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `_archive_game_impl` — new `mode = 'daily'` branch

**Files:**
- Create: `supabase/migrations/20260924000003_daily_stats_archive.sql`
- Modify: `scripts/smoke-daily-stats.mjs`

**Interfaces:**
- Consumes: `public.create_daily_room(p_host uuid, p_display_name text, p_date date default null)
  returns jsonb` (existing, unchanged) — used by the smoke test to create real daily rooms.
  `public.archive_game(p_room_id uuid, p_winner uuid) returns jsonb` (existing wrapper, unchanged
  — it already dispatches non-xtina rooms straight into `_archive_game_impl`).
- Produces: on a finished `mode = 'daily'` room, `_archive_game_impl` now inserts one row into
  `daily_results` and updates `profile_stats.daily_best_time_ms` (least) and
  `daily_total_time_ms` (+duration) for that profile's `mode = 'daily'` row. Later tasks
  (`get_daily_result_summary`) read both.

- [ ] **Step 1: Write the failing test — append to `scripts/smoke-daily-stats.mjs`**

Insert this new section right before the final `console.log('\nAll smoke-daily-stats checks
passed.');` line (replace that line with the block below, which ends with the same final log):

```js
  console.log('\narchive_game: daily branch writes daily_results + profile_stats');

  async function makeDailyPuzzle(daysFromToday) {
    const { rows } = await client.query(
      `insert into public.daily_puzzles
         (language, letter_multiset, grid_state, dictionary_config, floor_score, spread_score,
          distinct_board_count, replay_run_count, status, scheduled_date, generation_seed, first_word)
       values ('en', 'AAAABBBBCCCCDDDDEEEEFFFF', '{}'::jsonb,
               '{"minLength":2,"maxLength":null,"baseEnabled":true,"excludedTopics":[],"customSetIds":[]}'::jsonb,
               1.0, 0.5, 1, 1, 'scheduled', current_date + $1, 1, 'TEST')
       returning id, scheduled_date`,
      [daysFromToday],
    );
    return rows[0];
  }

  async function playDailyRoom(profileId, scheduledDate, durationMs) {
    const room = (await client.query(
      `select public.create_daily_room($1, 'Smoke Tester', $2::date) as r`,
      [profileId, scheduledDate],
    )).rows[0].r;
    const roomId = room.roomId ?? room.room_id ?? room.id;
    await client.query(
      `update public.rooms
         set status = 'finished',
             started_at = now(),
             finished_at = now() + ($1 || ' milliseconds')::interval,
             winner_id = $2
       where id = $3`,
      [durationMs, profileId, roomId],
    );
    await client.query(`select public.archive_game($1, $2)`, [roomId, profileId]);
    return { roomId, puzzleId: room.puzzleId };
  }

  const puzzleA = await makeDailyPuzzle(31);
  const alice = await makeUser(`alice-${Date.now()}@example.test`);
  const { puzzleId: puzzleAId } = await playDailyRoom(alice, puzzleA.scheduled_date, 100000);

  const dr = (await client.query(
    `select duration_ms from public.daily_results where puzzle_id = $1 and profile_id = $2`,
    [puzzleAId, alice],
  )).rows[0];
  assert(dr.duration_ms === 100000, 'daily_results row recorded with the correct duration');

  const stat1 = (await client.query(
    `select daily_best_time_ms, daily_total_time_ms from public.profile_stats
       where profile_id = $1 and mode = 'daily'`,
    [alice],
  )).rows[0];
  assert(stat1.daily_best_time_ms === 100000, 'first daily game sets daily_best_time_ms to its duration');
  assert(Number(stat1.daily_total_time_ms) === 100000, 'first daily game sets daily_total_time_ms to its duration');

  // A second, SLOWER daily game (different puzzle/day) must not raise the best time, but must
  // add to the running total.
  const puzzleB = await makeDailyPuzzle(32);
  await playDailyRoom(alice, puzzleB.scheduled_date, 150000);
  const stat2 = (await client.query(
    `select daily_best_time_ms, daily_total_time_ms from public.profile_stats
       where profile_id = $1 and mode = 'daily'`,
    [alice],
  )).rows[0];
  assert(stat2.daily_best_time_ms === 100000, 'a slower second game does not raise daily_best_time_ms');
  assert(Number(stat2.daily_total_time_ms) === 250000, 'daily_total_time_ms accumulates across games (100000+150000)');

  console.log('\nAll smoke-daily-stats checks passed.');
  await client.end();
}

main().catch((err) => {
  console.error(err);
  client.end();
  process.exit(1);
});
```

(This replaces the file's existing closing `console.log`/`main().catch(...)` block — the new
code must run *inside* `main()`, immediately after the Task 1 checks and before the closing
`console.log('\nAll smoke-daily-stats checks passed.');`.)

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
node scripts/smoke-daily-stats.mjs
```
Expected: FAIL on `daily_results row recorded with the correct duration` (or a null-row read
error) — `_archive_game_impl` doesn't write to `daily_results` yet, and
`daily_best_time_ms`/`daily_total_time_ms` stay at their defaults.

- [ ] **Step 3: Write the migration**

First, get the current `_archive_game_impl` body to modify — it's a `create or replace function`,
so the migration simply redefines it with one new block added. Read the latest version from
`supabase/migrations/20260918000001_nail_biter_one_tile_left.sql` (the most recent
`create or replace function public._archive_game_impl` before this plan) and reproduce it
verbatim with the new block inserted. Create
`supabase/migrations/20260924000003_daily_stats_archive.sql`:

```sql
-- _archive_game_impl — add a mode = 'daily' branch: record this completion into daily_results
-- (for the live beat-percent comparison) and roll the duration into profile_stats'
-- daily_best_time_ms (least) / daily_total_time_ms (running sum), same shape and same loop
-- position as the existing solo_best_times block. Daily rooms are single-player, so the only way
-- one finishes is the sole player winning — no v_is_winner guard is needed beyond the
-- started_at/finished_at check.
create or replace function public._archive_game_impl(p_room_id uuid, p_winner uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_player_count int;
  v_split_at timestamptz;
  v_since timestamptz;
  v_p record;
  v_peels int;
  v_dumps int;
  v_peel_streak int;
  v_first_peel_at timestamptz;
  v_first_peel_ms int;
  v_is_winner boolean;
  v_game_date date;
  v_stat public.profile_stats;
  v_prof public.profiles;
  v_new_streak int;
  v_nail_biter boolean;
  v_agg_games int;
  v_agg_peels int;
  v_bunch_key text;
  v_duration_ms int;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;

  if v_room.stats_applied then
    return jsonb_build_object('ok', true, 'roomId', p_room_id, 'alreadyApplied', true);
  end if;

  v_since := coalesce(v_room.started_at, '-infinity'::timestamptz);

  select count(*) into v_player_count
    from public.room_players where room_id = p_room_id and not is_spectator;

  select min(created_at) into v_split_at
    from public.room_events
    where room_id = p_room_id and type = 'game_started' and created_at >= v_since;

  select exists (
    select 1 from public.room_players
    where room_id = p_room_id
      and not is_spectator
      and profile_id <> p_winner
      and remaining_count = 1
  ) into v_nail_biter;

  v_game_date := coalesce(v_room.finished_at, now())::date;

  for v_p in
    select profile_id, tile_count
    from public.room_players
    where room_id = p_room_id and not is_spectator
    order by seat
  loop
    select count(*) into v_peels from public.room_events
      where room_id = p_room_id and type = 'peel'
        and payload ->> 'actor' = v_p.profile_id::text and created_at >= v_since;
    select count(*) into v_dumps from public.room_events
      where room_id = p_room_id and type = 'dump'
        and payload ->> 'actor' = v_p.profile_id::text and created_at >= v_since;
    select min(created_at) into v_first_peel_at from public.room_events
      where room_id = p_room_id and type = 'peel'
        and payload ->> 'actor' = v_p.profile_id::text and created_at >= v_since;
    v_first_peel_ms := case when v_first_peel_at is not null and v_split_at is not null
      then (extract(epoch from (v_first_peel_at - v_split_at)) * 1000)::int end;

    v_is_winner := v_p.profile_id = p_winner;

    if v_room.mode = 'multiplayer' then
      v_peel_streak := public._best_peel_streak(p_room_id, v_p.profile_id, v_since);
    else
      v_peel_streak := 0;
    end if;

    select * into v_stat from public.profile_stats
      where profile_id = v_p.profile_id and mode = v_room.mode;
    if not found then
      insert into public.profile_stats (
        profile_id, mode, games_played, games_won, total_peels, total_dumps,
        fastest_peel_ms, best_peel_streak, updated_at
      ) values (
        v_p.profile_id, v_room.mode, 1, (v_is_winner)::int, v_peels, v_dumps,
        v_first_peel_ms, v_peel_streak, now()
      );
    else
      update public.profile_stats set
        games_played = v_stat.games_played + 1,
        games_won = v_stat.games_won + (v_is_winner)::int,
        total_peels = v_stat.total_peels + v_peels,
        total_dumps = v_stat.total_dumps + v_dumps,
        fastest_peel_ms = least(
          coalesce(v_stat.fastest_peel_ms, 2147483647),
          coalesce(v_first_peel_ms, 2147483647)),
        best_peel_streak = greatest(v_stat.best_peel_streak, v_peel_streak),
        updated_at = now()
      where profile_id = v_p.profile_id and mode = v_room.mode;
    end if;
    update public.profile_stats set fastest_peel_ms = null
      where profile_id = v_p.profile_id and mode = v_room.mode and fastest_peel_ms = 2147483647;

    -- Best time per Bunch size (Timed solo wins only).
    if v_room.mode = 'solo' and v_is_winner
       and coalesce((v_room.mode_config ->> 'timed')::boolean, false)
       and v_room.started_at is not null and v_room.finished_at is not null then
      v_bunch_key := v_room.mode_config ->> 'bunchSize';
      v_duration_ms := greatest(0, (extract(epoch from (v_room.finished_at - v_room.started_at)) * 1000)::int);
      update public.profile_stats set
        solo_best_times = jsonb_set(
          coalesce(solo_best_times, '{}'::jsonb),
          array[v_bunch_key],
          to_jsonb(least(coalesce((solo_best_times ->> v_bunch_key)::int, 2147483647), v_duration_ms)),
          true)
        where profile_id = v_p.profile_id and mode = 'solo';
    end if;

    -- Daily challenge: record this completion for the live beat-percent comparison
    -- (daily_results), and roll it into this profile's personal best/average.
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

    select * into v_prof from public.profiles where id = v_p.profile_id;
    if v_prof.last_played_date = v_game_date then
      v_new_streak := v_prof.current_streak;
    elsif v_prof.last_played_date = v_game_date - 1 then
      v_new_streak := v_prof.current_streak + 1;
    else
      v_new_streak := 1;
    end if;
    update public.profiles set
      current_streak = v_new_streak,
      longest_streak = greatest(v_prof.longest_streak, v_new_streak),
      last_played_date = v_game_date
      where id = v_p.profile_id;

    if v_first_peel_ms is not null and v_first_peel_ms <= 60000 then
      perform public._unlock_achievement(v_p.profile_id, 'speed_peeler', jsonb_build_object('roomId', p_room_id, 'ms', v_first_peel_ms));
    end if;
    if v_is_winner and v_p.tile_count >= 100 then
      perform public._unlock_achievement(v_p.profile_id, 'marathon_mind', jsonb_build_object('roomId', p_room_id, 'tiles', v_p.tile_count));
    end if;
    if v_is_winner and v_dumps = 0 then
      perform public._unlock_achievement(v_p.profile_id, 'no_dumps_given', jsonb_build_object('roomId', p_room_id));
    end if;
    if v_player_count >= 8 then
      perform public._unlock_achievement(v_p.profile_id, 'full_house', jsonb_build_object('roomId', p_room_id));
    end if;
    if v_is_winner and v_nail_biter then
      perform public._unlock_achievement(v_p.profile_id, 'nail_biter', jsonb_build_object('roomId', p_room_id));
    end if;
    select coalesce(sum(games_played), 0), coalesce(sum(total_peels), 0)
      into v_agg_games, v_agg_peels
      from public.profile_stats where profile_id = v_p.profile_id;
    if v_agg_games >= 100 then
      perform public._unlock_achievement(v_p.profile_id, 'century_club', jsonb_build_object('games', v_agg_games));
    end if;
    if v_agg_peels >= 1000 then
      perform public._unlock_achievement(v_p.profile_id, 'peel_machine', jsonb_build_object('peels', v_agg_peels));
    end if;
  end loop;

  update public.rooms set stats_applied = true where id = p_room_id;

  return jsonb_build_object('ok', true, 'roomId', p_room_id, 'alreadyApplied', false);
end;
$$;
```

- [ ] **Step 4: Apply the migration and run the test again**

Run:
```bash
npm run db:reset
node scripts/smoke-daily-stats.mjs
```
Expected: all checks print `ok`, ending with `All smoke-daily-stats checks passed.`

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260924000003_daily_stats_archive.sql scripts/smoke-daily-stats.mjs
git commit -m "$(cat <<'EOF'
feat(daily): roll daily completions into daily_results + profile_stats

_archive_game_impl now records every daily-puzzle finish into
daily_results (for the beat-percent comparison) and updates
daily_best_time_ms/daily_total_time_ms on profile_stats.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `get_daily_result_summary` RPC

**Files:**
- Create: `supabase/migrations/20260924000004_daily_result_summary_rpc.sql`
- Modify: `scripts/smoke-daily-stats.mjs`

**Interfaces:**
- Consumes: `public.daily_results`, `public.profile_stats.daily_best_time_ms` (both from Task 1/2).
- Produces: `public.get_daily_result_summary(p_puzzle_id uuid, p_profile_id uuid) returns jsonb`,
  shape:
  ```
  { available: false }
  // or
  { available: true, beatPercent: number | null, totalPlayersToday: number,
    isPersonalBest: boolean, personalBestMs: number | null }
  ```
  Service-role only. Task 4 (Worker route) calls this by name with these exact parameter names.

- [ ] **Step 1: Write the failing test — append to `scripts/smoke-daily-stats.mjs`**

Insert this new section before the final `console.log('\nAll smoke-daily-stats checks
passed.');` (same splice pattern as Task 2 — the block ends by restoring that same closing log
and `main().catch(...)`):

```js
  console.log('\nget_daily_result_summary');

  // Two players on the same puzzle: alice (100000ms, from the archive test above) and a
  // freshly-added faster player, bob (50000ms).
  const bob = await makeUser(`bob-${Date.now()}@example.test`);
  await playDailyRoom(bob, puzzleA.scheduled_date, 50000);

  const aliceSummary = (await client.query(
    `select public.get_daily_result_summary($1, $2) as s`, [puzzleAId, alice],
  )).rows[0].s;
  assert(aliceSummary.available === true, 'alice has a result for puzzleA');
  assert(aliceSummary.totalPlayersToday === 2, 'two players have played puzzleA');
  assert(aliceSummary.beatPercent === 0, 'alice (100000ms) beat 0% — the only other player (bob) was faster');
  assert(aliceSummary.isPersonalBest === true, 'alice\'s puzzleA time (100000ms) is still her personal best (her puzzleB run was slower, at 150000ms)');
  assert(aliceSummary.personalBestMs === 100000, 'personalBestMs reflects her best time, 100000ms');

  const bobSummary = (await client.query(
    `select public.get_daily_result_summary($1, $2) as s`, [puzzleAId, bob],
  )).rows[0].s;
  assert(bobSummary.beatPercent === 100, 'bob (50000ms) beat 100% — the only other player (alice) was slower');
  assert(bobSummary.isPersonalBest === true, 'bob\'s first daily game is trivially his personal best');

  // A puzzle only one player has ever finished: beatPercent must be null (nothing to compare
  // against), not 0 or 100.
  const puzzleC = await makeDailyPuzzle(33);
  const carol = await makeUser(`carol-${Date.now()}@example.test`);
  const { puzzleId: puzzleCId } = await playDailyRoom(carol, puzzleC.scheduled_date, 80000);
  const carolSummary = (await client.query(
    `select public.get_daily_result_summary($1, $2) as s`, [puzzleCId, carol],
  )).rows[0].s;
  assert(carolSummary.beatPercent === null, 'beatPercent is null when no one else has played this puzzle yet');
  assert(carolSummary.totalPlayersToday === 1, 'totalPlayersToday is 1 (just carol)');

  // A profile who never played this puzzle at all.
  const dave = await makeUser(`dave-${Date.now()}@example.test`);
  const daveSummary = (await client.query(
    `select public.get_daily_result_summary($1, $2) as s`, [puzzleCId, dave],
  )).rows[0].s;
  assert(daveSummary.available === false, 'a profile with no result for this puzzle gets available: false');

  console.log('\nAll smoke-daily-stats checks passed.');
  await client.end();
}

main().catch((err) => {
  console.error(err);
  client.end();
  process.exit(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
node scripts/smoke-daily-stats.mjs
```
Expected: FAIL with a Postgres error — `function public.get_daily_result_summary(uuid, uuid)
does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260924000004_daily_result_summary_rpc.sql`:

```sql
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
```

- [ ] **Step 4: Apply the migration and run the test again**

Run:
```bash
npm run db:reset
node scripts/smoke-daily-stats.mjs
```
Expected: all checks print `ok`, ending with `All smoke-daily-stats checks passed.`

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260924000004_daily_result_summary_rpc.sql scripts/smoke-daily-stats.mjs
git commit -m "$(cat <<'EOF'
feat(daily): add get_daily_result_summary RPC for the beat-% comparison

Live-computed (not frozen) percentage of today's daily-puzzle players
you've beaten so far, plus whether this run was a personal best.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Worker route `GET /daily/:puzzleId/result-summary`

**Files:**
- Modify: `apps/api/src/index.ts` (add route near the existing `/daily/today` route at line 143)

**Interfaces:**
- Consumes: `public.get_daily_result_summary(p_puzzle_id uuid, p_profile_id uuid)` (Task 3).
  `requireAuth` middleware already applies to `/daily/*` (line 29) and sets
  `c.get('profileId')`.
- Produces: `GET /daily/:puzzleId/result-summary` → JSON body matching the RPC's jsonb shape
  exactly (`{available, beatPercent?, totalPlayersToday?, isPersonalBest?, personalBestMs?}`).
  Task 5 (`lib/api.ts`) consumes this exact shape.

- [ ] **Step 1: Add the route**

In `apps/api/src/index.ts`, immediately after the existing `/daily/today` handler (ends at line
166 with the closing `});`), add:

```ts
// Live "beat X% of today's players" + personal-best comparison for one daily puzzle. Recomputed
// on every call — never cached — so it climbs as more players finish the same puzzle later in
// the day. profileId comes from requireAuth (already applied to /daily/*).
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

- [ ] **Step 2: Typecheck**

Run:
```bash
npm run --workspace apps/api typecheck
```
Expected: no errors. (Full request/response proof happens live in Task 9's browser check — this
Worker has no test runner, only `typecheck`, matching every other route in this file.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "$(cat <<'EOF'
feat(daily): add GET /daily/:puzzleId/result-summary Worker route

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Client API — `lib/api.ts`

**Files:**
- Modify: `apps/web/src/lib/api.ts`

**Interfaces:**
- Consumes: `GET /daily/:puzzleId/result-summary` (Task 4).
- Produces: `export interface DailyResultSummary` and `api.getDailyResultSummary(puzzleId:
  string): Promise<DailyResultSummary>`. Task 8 (`Results.tsx`) imports and calls this.

- [ ] **Step 1: Add the type and method**

In `apps/web/src/lib/api.ts`, add this interface next to `DailyTodayResult` (after line 81):

```ts
export interface DailyResultSummary {
  available: boolean;
  beatPercent?: number | null;
  totalPlayersToday?: number;
  isPersonalBest?: boolean;
  personalBestMs?: number | null;
}
```

Add this method to the `api` object, next to `getDailyToday` (after line 159):

```ts
  getDailyResultSummary: (puzzleId: string) =>
    call<DailyResultSummary>(`/daily/${encodeURIComponent(puzzleId)}/result-summary`),
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npm run --workspace apps/web typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "$(cat <<'EOF'
feat(daily): add getDailyResultSummary to the API client

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Client stats plumbing — `lib/profile.ts`

**Files:**
- Modify: `apps/web/src/lib/profile.ts`

**Interfaces:**
- Consumes: nothing new (reads the `profile_stats` columns from Task 1 via the existing
  `supabase.from('profile_stats')` reads).
- Produces: `GameMode` includes `'daily'`; `ProfileStatsRow` gains `daily_best_time_ms: number |
  null` and `daily_total_time_ms: number`; `aggregateStats` merges both. Task 7 (`Profile.tsx`)
  consumes these exact field names.

- [ ] **Step 1: Widen `GameMode` and `ProfileStatsRow`**

In `apps/web/src/lib/profile.ts`, change line 13:

```ts
export type GameMode = 'multiplayer' | 'solo';
```
to:
```ts
export type GameMode = 'multiplayer' | 'solo' | 'daily';
```

Add these two fields to `ProfileStatsRow` (after `solo_best_times` at line 50-51):

```ts
  /** Daily challenge only (null/0 on every other mode's row). Average is total/games_played,
   * computed at render time — no stored average column. */
  daily_best_time_ms: number | null;
  daily_total_time_ms: number;
```

- [ ] **Step 2: Merge the new fields in `aggregateStats`**

In `aggregateStats` (starting line 74), add two accumulator variables alongside `bestTimes`
(after line 85):

```ts
  let dailyBestMs: number | null = null;
  let dailyTotalMs = 0;
```

Inside the `for (const r of rows)` loop, add this alongside the existing `solo_best_times` merge
(after the `for (const [bunchSize, ms] of ...)` block, still inside the outer loop, before the
closing `}` of the `for (const r of rows)` loop):

```ts
    if (r.daily_best_time_ms != null) {
      dailyBestMs = dailyBestMs == null ? r.daily_best_time_ms : Math.min(dailyBestMs, r.daily_best_time_ms);
    }
    dailyTotalMs += r.daily_total_time_ms ?? 0;
```

In the returned object (starting line 109), add the two fields alongside `solo_best_times`:

```ts
    daily_best_time_ms: dailyBestMs,
    daily_total_time_ms: dailyTotalMs,
```

- [ ] **Step 3: Typecheck**

Run:
```bash
npm run --workspace apps/web typecheck
```
Expected: no errors. (`fetchMyStats('daily')` will now type-check and return rows including the
two new fields; there is no unit test runner in this workspace, so this and the later browser
check in Task 9 are the verification for this task.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/profile.ts
git commit -m "$(cat <<'EOF'
feat(daily): add daily mode + best/average time to ProfileStatsRow

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Client Stats tab — `pages/Profile.tsx`

**Files:**
- Modify: `apps/web/src/pages/Profile.tsx`

**Interfaces:**
- Consumes: `ProfileStatsRow.daily_best_time_ms`/`daily_total_time_ms` (Task 6),
  `formatBestTime` (existing local helper, line 474).
- Produces: a `'daily'` option in the Stats tab's mode selector; two new tiles.

- [ ] **Step 1: Add the "Daily" filter option**

In `StatsBoard` (line 483), change:

```ts
  const filterOptions: { id: StatsFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'multiplayer', label: 'Multiplayer' },
    { id: 'solo', label: 'Solo' },
  ];
```
to:
```ts
  const filterOptions: { id: StatsFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'multiplayer', label: 'Multiplayer' },
    { id: 'solo', label: 'Solo' },
    { id: 'daily', label: 'Daily' },
  ];
```

- [ ] **Step 2: Hide win-rate/peel-streak tiles for daily, same as solo**

Change line 515:
```ts
  const showCompetitiveStats = filter !== 'solo';
```
to:
```ts
  const showCompetitiveStats = filter !== 'solo' && filter !== 'daily';
```

- [ ] **Step 3: Add the best-time and average-time tiles**

After the `soloBestTimeTiles` block (lines 533-539), add:

```ts
  // Best time is safe to show on 'all' too (min is associative regardless of which modes
  // contributed). Average is daily-filter-only: on 'all', stats.games_played is summed across
  // every mode, so dividing daily_total_time_ms by it there would silently produce a wrong
  // number rather than a missing one — see the 2026-09-24 design doc.
  const showDailyBestTime = filter !== 'multiplayer' && filter !== 'solo';
  const dailyBestTimeTile = showDailyBestTime
    ? [{ label: 'Best time (daily)', value: formatBestTime(stats.daily_best_time_ms ?? undefined) }]
    : [];
  const dailyAverageTimeTile =
    filter === 'daily' && stats.games_played > 0
      ? [{ label: 'Average time (daily)', value: formatBestTime(stats.daily_total_time_ms / stats.games_played) }]
      : [];
```

In the `tiles` array (starting line 541), add both alongside `...soloBestTimeTiles`:

```ts
    ...soloBestTimeTiles,
    ...dailyBestTimeTile,
    ...dailyAverageTimeTile,
```

- [ ] **Step 4: Typecheck and build**

Run:
```bash
npm run --workspace apps/web typecheck
npm run --workspace apps/web build
```
Expected: both succeed with no errors. (Rendering is verified live in Task 9.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Profile.tsx
git commit -m "$(cat <<'EOF'
feat(daily): add Daily filter + best/average time tiles to Stats tab

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Results page — beat-percent tile + personal-best badge

**Files:**
- Modify: `apps/web/src/pages/Results.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `api.getDailyResultSummary` and `DailyResultSummary` (Task 5).
- Produces: nothing consumed elsewhere — this is the last piece of the visible feature.

- [ ] **Step 1: Add state and the import**

In `apps/web/src/pages/Results.tsx`, change the import on line 9:

```ts
import { api, ApiError, getErrorMessage } from '../lib/api.js';
```
to:
```ts
import { api, ApiError, getErrorMessage, type DailyResultSummary } from '../lib/api.js';
```

Add new state alongside `streak` (after line 35):

```ts
  const [dailySummary, setDailySummary] = useState<DailyResultSummary | null>(null);
```

- [ ] **Step 2: Add the fetch effect**

Add this new effect after the existing daily-streak-recording effect (after line 138, before the
`useRoomEvents` call on line 143). It follows the same retry pattern as the board-fetch effect
(lines 90-119), since it races the same async `archive_game` write:

```ts
  // The beat-percent comparison depends on the same async archive_game write as the streak
  // recording above, so it uses the same "fetch, then retry once after the write has likely
  // landed" pattern as the board-fetch effect.
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
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [room]);
```

- [ ] **Step 3: Render the tile and badge**

In the `{me && (...)}` panel (starting line 289), add this new block right after the
achievements sub-blocks and right before that panel's closing `</div>` (i.e. immediately before
line 338's `</div>`):

```tsx
          {isDaily && (
            <div className="daily-beat-percent">
              {!dailySummary && (
                <span className="results-achievements-label">
                  Checking today's rankings… <span className="skeleton-bar" />
                </span>
              )}
              {dailySummary?.available && dailySummary.beatPercent != null && (
                <span className="daily-streak-update">
                  🏆 Beat {dailySummary.beatPercent}% of today's players
                </span>
              )}
              {dailySummary?.available && dailySummary.beatPercent == null && (
                <span className="daily-streak-update">🥇 Be the first to solve today!</span>
              )}
              {dailySummary?.isPersonalBest && (
                <span className="daily-personal-best">✨ New personal best!</span>
              )}
            </div>
          )}
```

- [ ] **Step 4: Add the one new CSS class**

`.daily-streak-update` already exists and is reused as-is above. Add the one new class to
`apps/web/src/styles.css`, right after the existing `.daily-streak-update` block (after line
4222):

```css

/* Results page — daily-puzzle personal-best badge, under the beat-percent pill. */
.daily-personal-best {
  display: block;
  margin-top: var(--space-1);
  font-family: var(--font-body);
  font-weight: 700;
  font-size: var(--text-small);
  color: var(--color-accent);
  text-align: center;
}
```

- [ ] **Step 5: Typecheck and build**

Run:
```bash
npm run --workspace apps/web typecheck
npm run --workspace apps/web build
```
Expected: both succeed with no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/Results.tsx apps/web/src/styles.css
git commit -m "$(cat <<'EOF'
feat(daily): show beat-% and personal-best badge on the Results page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Browser verification (end-to-end)

**Files:** none (verification only).

This is the proof step every prior task's typecheck/build couldn't give: does the whole chain
actually work when two real players solve today's puzzle. Per this repo's standing practice
(CLAUDE.md), typecheck/build passing is never treated as proof a runtime feature works.

- [ ] **Step 1: Ensure a daily puzzle exists for today locally**

The Daily page needs a `daily_puzzles` row with `status = 'scheduled'` and
`scheduled_date = current_date` (UTC). Check whether `npm run db:reset` already seeds one
(search `supabase/seed` and the daily-puzzle-generation script referenced in
`docs/superpowers/specs/2026-08-14-daily-puzzle-generation-design.md`); if not, insert one
directly against the local stack:

```bash
node -e "
import('pg').then(async ({ default: pg }) => {
  const c = new pg.Client('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
  await c.connect();
  await c.query(\`insert into public.daily_puzzles
    (language, letter_multiset, grid_state, dictionary_config, floor_score, spread_score,
     distinct_board_count, replay_run_count, status, scheduled_date, generation_seed, first_word)
    values ('en', 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', '{}'::jsonb,
      '{\"minLength\":2,\"maxLength\":null,\"baseEnabled\":true,\"excludedTopics\":[],\"customSetIds\":[]}'::jsonb,
      1.0, 0.5, 1, 1, 'scheduled', current_date, 1, 'TEST')
    on conflict do nothing\`);
  await c.end();
});
"
```

- [ ] **Step 2: Start the local stack**

```bash
npm run dev:api
```
(in one terminal) and
```bash
npm run dev:web
```
(in another). Both `predev:*` hooks bring up Docker/Supabase automatically.

- [ ] **Step 3: Play the daily puzzle as two separate guest sessions**

Using the built-in browser pane (or two separate normal + incognito windows): open the web app
in two isolated sessions (auth is `sessionStorage`-scoped, so two different browser
profiles/private windows give two distinct guests). In each: navigate to **Daily Puzzle**, click
**Play Today's Puzzle**, place all tiles into one connected grid to trigger Plantains
automatically. Finish the second session noticeably slower than the first (just wait a bit
before placing the last tile).

- [ ] **Step 4: Verify the Results page**

On the **second (slower)** session's Results page, confirm:
- The "Beat X% of today's players" tile appears (should read `Beat 0%` — the only other player,
  session 1, was faster).
- No personal-best badge on this second play if it's this guest's first-ever daily game, it
  IS trivially a personal best — confirm the "✨ New personal best!" line appears (first daily
  game for a fresh profile is always a personal best, same as the smoke test's `bob` case).

On the **first (faster)** session's Results page (reopen `/daily` and re-navigate to its
already-solved state if needed, or check immediately if still open), confirm it shows
`Beat 100%`.

- [ ] **Step 5: Verify the Profile Stats tab**

For either session: navigate to **Profile → Stats**, click the new **Daily** filter pill.
Confirm:
- "Games played" is nonzero.
- "Longest word" and "Favorite starting letter" are populated (not `-`) — this is the direct
  proof that the Task 1 `profile_stats_mode_check` bugfix worked, since these came from
  `submit_game_summary`, which was silently failing before this plan.
- "Best time (daily)" and "Average time (daily)" show real `m:ss` values, not `-`.
- Win rate / best peel streak tiles are hidden on this filter (same as they are on Solo).

- [ ] **Step 6: Report results**

State plainly what was and wasn't confirmed working (per this repo's verification-honesty
convention) — e.g. if Docker Desktop isn't available in the current environment, say so
explicitly rather than inferring success from the earlier typecheck/build passes.

No commit for this task (verification only, no file changes) — unless Step 1's seed insert needs
to become a permanent fixture, in which case note that as a follow-up rather than folding it in
here.

---

## Self-Review Notes

- **Spec coverage**: every item in the design doc has a task — schema fix (Task 1), archive
  branch (Task 2), summary RPC (Task 3), Worker route (Task 4), client API (Task 5), stats
  plumbing (Task 6), Stats tab UI (Task 7), Results page UI (Task 8), and the out-of-scope items
  (streak sync, global leaderboard) are explicitly not tasked, matching the spec's "out of
  scope" section.
- **Placeholder scan**: no TBD/TODO; every step has literal code, not a description of code.
- **Type consistency**: `DailyResultSummary` (Task 5) matches `get_daily_result_summary`'s jsonb
  keys exactly (Task 3); `ProfileStatsRow.daily_best_time_ms`/`daily_total_time_ms` (Task 6)
  match the column names added in Task 1 and read/written in Task 2; `formatBestTime` (Task 7)
  is the existing helper already in scope in `Profile.tsx`, not redefined.
