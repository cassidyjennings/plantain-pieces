# Peel Streak & Favorite Starting Letter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Stats tab's `Choke rate` and `Alphabet letters` tiles with `Best peel streak`
(multiplayer-only, lifetime best) and `Favorite starting letter` (lifetime, all tied letters
shown), and bundle in a fix so xtina games contribute zero stats end-to-end.

**Architecture:** One migration adds two small pure/stable SQL helper functions
(`_merge_letter_counts`, `_best_peel_streak`), rewires `_archive_game_impl` and
`submit_game_summary` to use them, and changes `profile_stats`' shape (drop `choke_count`, add
`best_peel_streak` + `first_letter_counts`). Client changes are a type update, an aggregation
tweak, and a tile swap.

**Tech Stack:** PostgreSQL/PL-pgSQL (Supabase migrations), Node.js smoke-test scripts (`pg` client,
this repo's existing pattern — see `scripts/smoke-xtina.mjs`), TypeScript/React (`apps/web`).

## Global Constraints

- Migrations are `create or replace` on existing RPC signatures — never drop/recreate unless the
  parameter list changes (it doesn't here).
- Every migration is verified locally via `npm run db:reset` before being handed off for manual
  prod application (this repo never auto-applies migrations to prod).
- No per-game data is stored anywhere (rooms are swept 24h after finishing) — all new stats must
  be lifetime aggregates on `profile_stats`, computed at `archive_game`/`submit_game_summary` time
  from `room_events`, which still exist at that point.
- Follow the existing smoke-test convention: a `scripts/smoke-*.mjs` file using the `pg` client
  directly against the local stack (`postgresql://postgres:postgres@127.0.0.1:54322/postgres`),
  with a tiny `assert(cond, label)` helper — see `scripts/smoke-xtina.mjs` for the exact shape to
  match (including `makeUser()` for creating real `auth.users` rows so the `profiles` trigger
  fires).

---

### Task 1: Schema change + two pure SQL helper functions

**Files:**
- Create: `supabase/migrations/20260808000002_stats_peel_streak_favorite_letter.sql`
- Create: `scripts/smoke-stats-helpers.mjs`

**Interfaces:**
- Produces: `public._merge_letter_counts(a jsonb, b jsonb) returns jsonb` — sums two per-letter
  count maps key-wise (union of keys, add values). Pure, no table reads.
- Produces: `public._best_peel_streak(p_room_id uuid, p_profile_id uuid, p_since timestamptz) returns int`
  — longest run of consecutive `'peel'` room_events for that profile in that room (from
  `p_since` onward) uninterrupted by a `'dump'` event. Reads `public.room_events`.
- Produces (schema): `profile_stats.best_peel_streak int not null default 0`,
  `profile_stats.first_letter_counts jsonb not null default '{}'::jsonb`. `choke_count` column is
  gone.

- [ ] **Step 1: Write the migration's schema + helper-function SQL**

```sql
-- supabase/migrations/20260808000002_stats_peel_streak_favorite_letter.sql

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
```

- [ ] **Step 2: Write the smoke test for both helpers**

```js
// scripts/smoke-stats-helpers.mjs
// Scripted smoke test for the two pure stats helpers against the LOCAL supabase stack.
// Run from the repo root:  node scripts/smoke-stats-helpers.mjs
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
  console.log('_merge_letter_counts');

  const m1 = (await client.query(
    `select public._merge_letter_counts('{"A":2,"B":1}'::jsonb, '{"A":3,"C":5}'::jsonb) as r`,
  )).rows[0].r;
  assert(JSON.stringify(m1) === JSON.stringify({ A: 5, B: 1, C: 5 }), 'sums overlapping and new keys');

  const m2 = (await client.query(
    `select public._merge_letter_counts('{}'::jsonb, '{"Z":1}'::jsonb) as r`,
  )).rows[0].r;
  assert(JSON.stringify(m2) === JSON.stringify({ Z: 1 }), 'merges against an empty map');

  console.log('\n_best_peel_streak');

  const profile = await makeUser(`streak-${Date.now()}@example.test`);
  const room = (await client.query(
    `select public.create_room($1, 'Streaker', null) as r`, [profile],
  )).rows[0].r;
  const roomId = room.roomId ?? room.room_id ?? room.id;

  // peel, peel, dump, peel, peel, peel  ->  longest run is 3
  const seq = ['peel', 'peel', 'dump', 'peel', 'peel', 'peel'];
  for (let i = 0; i < seq.length; i++) {
    await client.query(
      `insert into public.room_events (room_id, type, payload, created_at)
       values ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
      [roomId, seq[i], JSON.stringify({ actor: profile }), i],
    );
  }
  const since = (await client.query(`select created_at from public.rooms where id = $1`, [roomId])).rows[0].created_at;
  const streak = (await client.query(
    `select public._best_peel_streak($1, $2, $3) as s`, [roomId, profile, since],
  )).rows[0].s;
  assert(streak === 3, 'longest uninterrupted peel run is 3, not the total (5) or the first run (2)');

  const noEvents = (await client.query(
    `select public._best_peel_streak($1, $2, now()) as s`, [roomId, profile],
  )).rows[0].s;
  assert(noEvents === 0, 'no events after the cutoff yields 0, not null or an error');

  console.log('\nAll smoke-stats-helpers checks passed.');
  await client.end();
}

main().catch((err) => {
  console.error(err);
  client.end();
  process.exit(1);
});
```

- [ ] **Step 3: Run it to confirm it fails first (helpers don't exist yet)**

Run: `npm run db:reset` (applies migrations up to, but not including, the new one you haven't
written) — actually for this step, temporarily skip writing the migration file first: run
`node scripts/smoke-stats-helpers.mjs` against the stack as it is *before* Step 1's SQL is applied.
Expected: FAIL with `function public._merge_letter_counts(jsonb, jsonb) does not exist`.

(If you wrote Step 1's file before running this, that's fine too — just confirm you understand
why it would have failed; the important thing is Step 4 proves the SQL is what makes it pass.)

- [ ] **Step 4: Apply the migration and re-run**

```bash
npm run db:reset
node scripts/smoke-stats-helpers.mjs
```

Expected: `db:reset` applies cleanly (no SQL errors), and every `ok` line prints with no `FAIL`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260808000002_stats_peel_streak_favorite_letter.sql scripts/smoke-stats-helpers.mjs
git commit -m "$(cat <<'EOF'
feat(db): add profile_stats peel-streak/favorite-letter schema + helpers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire peel streak into `_archive_game_impl`, drop choke tracking

**Files:**
- Modify: `supabase/migrations/20260808000002_stats_peel_streak_favorite_letter.sql` (append)
- Modify: `scripts/smoke-stats-helpers.mjs` → rename to `scripts/smoke-stats-tiles.mjs` (this task
  extends the same smoke script rather than starting a new one, since it's testing the same
  feature end-to-end; keep every assertion from Task 1)

**Interfaces:**
- Consumes: `public._best_peel_streak(uuid, uuid, timestamptz) returns int` (Task 1).
- Produces: `_archive_game_impl` now writes `best_peel_streak` (multiplayer-only, `GREATEST`
  lifetime max) instead of `choke_count`, for every profile it processes.

- [ ] **Step 1: Append the updated `_archive_game_impl` to the migration file**

Full function body, `create or replace` (same signature — safe to redeploy mid-flight), with
`v_min_tiles`/`v_is_choke` removed and peel-streak added:

```sql
-- ---------------------------------------------------------------------------
-- 4. _archive_game_impl — drop choke tracking (nothing reads choke_count once the Stats tab tile
--    is gone), add best_peel_streak. Peel streak is multiplayer-only: for solo/xtina rows
--    v_peel_streak stays 0, and GREATEST(existing, 0) is a no-op, so no per-mode branching is
--    needed in the INSERT/UPDATE itself.
-- ---------------------------------------------------------------------------
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
    select 1 from public.room_events e
    where e.room_id = p_room_id
      and e.type = 'plantains_rejected'
      and coalesce(e.payload ->> 'actor', '') <> p_winner::text
      and e.created_at <= v_room.finished_at
      and e.created_at >= v_room.finished_at - interval '5 seconds'
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

- [ ] **Step 2: Rename the smoke script and add the archive_game integration check**

```bash
git mv scripts/smoke-stats-helpers.mjs scripts/smoke-stats-tiles.mjs
```

Append to `scripts/smoke-stats-tiles.mjs`, before `console.log('\nAll smoke-stats-helpers checks passed.');` (and update that final message to say `smoke-stats-tiles`):

```js
  console.log('\narchive_game: best_peel_streak (multiplayer)');

  const owner = await makeUser(`owner-${Date.now()}@example.test`);
  const opp = await makeUser(`opp-${Date.now()}@example.test`);
  const mpRoom = (await client.query(`select public.create_room($1, 'Owner', null) as r`, [owner])).rows[0].r;
  const mpRoomId = mpRoom.roomId ?? mpRoom.room_id ?? mpRoom.id;
  await client.query(`select public.join_room($1, $2, 'Opp', false)`, [mpRoom.code, opp]);
  await client.query(`select public.start_game($1, $2)`, [mpRoomId, owner]);

  // Drive a peel-peel-dump-peel-peel-peel pattern directly via room_events (bypassing real
  // tile/bunch mechanics, which archive_game doesn't touch anyway) so this stays a fast, focused
  // check of the rollup logic rather than a full gameplay simulation.
  const mpSeq = ['peel', 'peel', 'dump', 'peel', 'peel', 'peel'];
  for (let i = 0; i < mpSeq.length; i++) {
    await client.query(
      `insert into public.room_events (room_id, type, payload, created_at)
       values ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
      [mpRoomId, mpSeq[i], JSON.stringify({ actor: owner }), i],
    );
  }
  await client.query(`update public.rooms set status = 'finished', finished_at = now(), winner_id = $1 where id = $2`, [owner, mpRoomId]);
  await client.query(`select public.archive_game($1, $2)`, [mpRoomId, owner]);

  const mpStat = (await client.query(
    `select best_peel_streak, choke_count is null as choke_column_gone
       from public.profile_stats where profile_id = $1 and mode = 'multiplayer'`,
    [owner],
  ).catch((err) => ({ rows: [{ error: err.message }] }))).rows[0];
  assert(mpStat.best_peel_streak === 3, 'multiplayer game rolls up a best_peel_streak of 3');

  const chokeGone = await client.query(
    `select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'profile_stats' and column_name = 'choke_count'`,
  );
  assert(chokeGone.rowCount === 0, 'choke_count column no longer exists');

  console.log('\nAll smoke-stats-tiles checks passed.');
```

- [ ] **Step 3: Run and verify**

```bash
npm run db:reset
node scripts/smoke-stats-tiles.mjs
```

Expected: all `ok` lines, no `FAIL`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260808000002_stats_peel_streak_favorite_letter.sql scripts/smoke-stats-tiles.mjs
git commit -m "$(cat <<'EOF'
feat(db): roll best_peel_streak into archive_game, drop choke tracking

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire favorite-letter tally into `submit_game_summary`, add the xtina guard

**Files:**
- Modify: `supabase/migrations/20260808000002_stats_peel_streak_favorite_letter.sql` (append)
- Modify: `scripts/smoke-stats-tiles.mjs` (append)

**Interfaces:**
- Consumes: `public._merge_letter_counts(jsonb, jsonb) returns jsonb` (Task 1).
- Produces: `submit_game_summary` now merges `first_letter_counts` and early-returns (marking
  `room_players.summary_applied = true`, no-op) for `mode = 'xtina'` rooms — matching
  `archive_game`'s existing xtina guard, so xtina contributes zero stats end-to-end. This is a
  defense-in-depth backstop: the Worker (`apps/api/src/index.ts:544-546`) already skips calling
  this RPC at all for xtina rooms, so this guard should never actually fire in production — it
  exists so the RPC is correct on its own, independent of the caller.

- [ ] **Step 1: Append the updated `submit_game_summary` to the migration file**

```sql
-- ---------------------------------------------------------------------------
-- 5. submit_game_summary — add the xtina guard archive_game already has (defense-in-depth; the
--    Worker already skips calling this RPC at all for xtina rooms), and tally first letters into
--    first_letter_counts alongside the existing first_letters set.
-- ---------------------------------------------------------------------------
create or replace function public.submit_game_summary(
  p_room_id uuid, p_profile uuid, p_summary jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_rp public.room_players;
  v_words text[];
  v_invalid text[];
  v_valid_words text[];
  v_word_count int;
  v_total_len bigint;
  v_longest text;
  v_longest_len int;
  v_rarest text;
  v_rarest_score int;
  v_new_letters text;
  v_letter_tally jsonb;
  v_stat public.profile_stats;
  v_merged text;
begin
  select * into v_room from public.rooms where id = p_room_id;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;

  if v_room.mode = 'xtina' then
    update public.room_players set summary_applied = true
      where room_id = p_room_id and profile_id = p_profile;
    return jsonb_build_object('ok', true, 'longestWord', null, 'rarestWord', null, 'wordCount', 0);
  end if;

  select * into v_rp from public.room_players
    where room_id = p_room_id and profile_id = p_profile
    for update;
  if not found then raise exception 'NOT_IN_ROOM' using errcode = 'P0002'; end if;

  select coalesce(array_agg(upper(w)), '{}') into v_words
    from jsonb_array_elements_text(coalesce(p_summary -> 'words', '[]'::jsonb)) w
    where upper(w) ~ '^[A-Z]{2,20}$';

  v_invalid := public._find_invalid_words_cfg(coalesce(v_room.dictionary_config, '{}'::jsonb), v_words);
  select coalesce(array_agg(w), '{}') into v_valid_words
    from unnest(v_words) w
    where not (w = any(v_invalid));

  v_word_count := coalesce(array_length(v_valid_words, 1), 0);
  select coalesce(sum(char_length(x)), 0) into v_total_len from unnest(v_valid_words) x;

  select x into v_longest from unnest(v_valid_words) x order by char_length(x) desc, x limit 1;
  v_longest_len := coalesce(char_length(v_longest), 0);

  select x, public.word_rarity(x) into v_rarest, v_rarest_score
    from unnest(v_valid_words) x order by public.word_rarity(x) desc, x limit 1;
  v_rarest_score := coalesce(v_rarest_score, 0);

  select string_agg(distinct substr(x, 1, 1), '' order by substr(x, 1, 1))
    into v_new_letters from unnest(v_valid_words) x;
  v_new_letters := coalesce(v_new_letters, '');

  select coalesce(jsonb_object_agg(letter, cnt), '{}'::jsonb) into v_letter_tally
    from (
      select substr(x, 1, 1) as letter, count(*) as cnt
      from unnest(v_valid_words) x
      group by substr(x, 1, 1)
    ) g;

  if not v_rp.summary_applied then
    select * into v_stat from public.profile_stats
      where profile_id = p_profile and mode = v_room.mode;
    if not found then
      insert into public.profile_stats (profile_id, mode, updated_at)
      values (p_profile, v_room.mode, now());
      select * into v_stat from public.profile_stats
        where profile_id = p_profile and mode = v_room.mode;
    end if;

    select string_agg(c, '' order by c) into v_merged from (
      select distinct unnest(string_to_array(coalesce(v_stat.first_letters, '') || v_new_letters, null)) as c
    ) s where c ~ '^[A-Z]$';

    update public.profile_stats set
      total_words = v_stat.total_words + v_word_count,
      total_word_length = v_stat.total_word_length + v_total_len,
      longest_word = case when v_longest_len > v_stat.longest_word_length then v_longest else v_stat.longest_word end,
      longest_word_length = greatest(v_stat.longest_word_length, v_longest_len),
      rarest_word = case when v_rarest_score > v_stat.rarest_word_score then v_rarest else v_stat.rarest_word end,
      rarest_word_score = greatest(v_stat.rarest_word_score, v_rarest_score),
      first_letters = coalesce(v_merged, v_stat.first_letters),
      first_letter_counts = public._merge_letter_counts(v_stat.first_letter_counts, v_letter_tally),
      updated_at = now()
    where profile_id = p_profile and mode = v_room.mode;

    update public.room_players set summary_applied = true where id = v_rp.id;

    if exists (select 1 from unnest(v_valid_words) x where public.word_rarity(x) >= 30) then
      perform public._unlock_achievement(p_profile, 'word_nerd',
        jsonb_build_object('roomId', p_room_id, 'word', v_rarest, 'score', v_rarest_score));
    end if;
    if coalesce(char_length(v_merged), 0) >= 26 then
      perform public._unlock_achievement(p_profile, 'alphabet_soup', jsonb_build_object('roomId', p_room_id));
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'longestWord', v_longest,
    'rarestWord', v_rarest,
    'wordCount', v_word_count
  );
end;
$$;
```

- [ ] **Step 2: Append the integration check to the smoke script**

Before the final `console.log('\nAll smoke-stats-tiles checks passed.');`:

```js
  console.log('\nsubmit_game_summary: first_letter_counts + xtina guard');

  await client.query(
    `update public.room_players set rack = '[]'::jsonb where room_id = $1 and profile_id = $2`,
    [mpRoomId, owner],
  );
  await client.query(
    `select public.submit_game_summary($1, $2, $3::jsonb)`,
    [mpRoomId, owner, JSON.stringify({ words: ['APPLE', 'ANT', 'BAT'] })],
  );
  const letters1 = (await client.query(
    `select first_letter_counts from public.profile_stats where profile_id = $1 and mode = 'multiplayer'`,
    [owner],
  )).rows[0].first_letter_counts;
  assert(letters1.A === 2 && letters1.B === 1, 'first submission tallies A:2, B:1');

  // A second room/game for the same player should ADD to the tally, not overwrite it.
  const opp2 = await makeUser(`opp2-${Date.now()}@example.test`);
  const mpRoom2 = (await client.query(`select public.create_room($1, 'Owner', null) as r`, [owner])).rows[0].r;
  const mpRoomId2 = mpRoom2.roomId ?? mpRoom2.room_id ?? mpRoom2.id;
  await client.query(`select public.join_room($1, $2, 'Opp2', false)`, [mpRoom2.code, opp2]);
  await client.query(`select public.start_game($1, $2)`, [mpRoomId2, owner]);
  await client.query(`select public.submit_game_summary($1, $2, $3::jsonb)`,
    [mpRoomId2, owner, JSON.stringify({ words: ['ANCHOR'] })]);
  const letters2 = (await client.query(
    `select first_letter_counts from public.profile_stats where profile_id = $1 and mode = 'multiplayer'`,
    [owner],
  )).rows[0].first_letter_counts;
  assert(letters2.A === 3 && letters2.B === 1, 'second submission adds to the existing tally (A:3), not overwrite');

  // Xtina guard: a summary call on an xtina room must not touch profile_stats at all.
  const xtinaPartner = await makeUser(`xpartner-${Date.now()}@example.test`);
  await client.query(`update public.profiles set xtina_role = 'owner' where id = $1`, [owner]);
  await client.query(`update public.profiles set xtina_role = 'partner' where id = $1`, [xtinaPartner]);
  await client.query(`select public.set_xtina_enabled($1, true)`, [owner]);
  const xRoom = (await client.query(`select public.create_room($1, 'Owner', null) as r`, [owner])).rows[0].r;
  const xRoomId = xRoom.roomId ?? xRoom.room_id ?? xRoom.id;
  await client.query(`select public.join_room($1, $2, 'Partner', false)`, [xRoom.code, xtinaPartner]);
  await client.query(`select public.start_game($1, $2)`, [xRoomId, owner]);
  const xMode = (await client.query(`select mode from public.rooms where id = $1`, [xRoomId])).rows[0].mode;
  assert(xMode === 'xtina', 'Split routed this room to xtina mode');

  const before = (await client.query(
    `select total_words from public.profile_stats where profile_id = $1 and mode = 'xtina'`,
    [owner],
  )).rowCount;
  await client.query(`select public.submit_game_summary($1, $2, $3::jsonb)`,
    [xRoomId, owner, JSON.stringify({ words: ['ZEBRA'] })]);
  const after = (await client.query(
    `select 1 from public.profile_stats where profile_id = $1 and mode = 'xtina'`,
    [owner],
  )).rowCount;
  assert(before === 0 && after === 0, 'xtina summary call creates no profile_stats row at all');
  const applied = (await client.query(
    `select summary_applied from public.room_players where room_id = $1 and profile_id = $2`,
    [xRoomId, owner],
  )).rows[0].summary_applied;
  assert(applied === true, 'xtina room_players.summary_applied is still marked true (no retry loop)');

  console.log('\nAll smoke-stats-tiles checks passed.');
```

- [ ] **Step 3: Run and verify**

```bash
npm run db:reset
node scripts/smoke-stats-tiles.mjs
```

Expected: all `ok` lines, no `FAIL`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260808000002_stats_peel_streak_favorite_letter.sql scripts/smoke-stats-tiles.mjs
git commit -m "$(cat <<'EOF'
feat(db): tally first_letter_counts in submit_game_summary, guard xtina

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Client types + aggregation

**Files:**
- Modify: `apps/web/src/lib/profile.ts:32-48` (`ProfileStatsRow`), `:71-114` (`aggregateStats`)

**Interfaces:**
- Consumes: `profile_stats` columns from Task 1-3 (`best_peel_streak int`,
  `first_letter_counts jsonb`; `choke_count` and `first_letters` are gone from what the client
  needs).
- Produces: `ProfileStatsRow` type used by `fetchMyStats()` (unchanged signature) and consumed by
  `StatsBoard` in Task 5.

- [ ] **Step 1: Update `ProfileStatsRow`**

In `apps/web/src/lib/profile.ts`, replace:

```ts
export interface ProfileStatsRow {
  profile_id: string;
  mode: GameMode;
  games_played: number;
  games_won: number;
  total_peels: number;
  total_dumps: number;
  total_words: number;
  total_word_length: number;
  longest_word: string | null;
  longest_word_length: number;
  fastest_peel_ms: number | null;
  rarest_word: string | null;
  rarest_word_score: number;
  first_letters: string;
  choke_count: number;
}
```

with:

```ts
export interface ProfileStatsRow {
  profile_id: string;
  mode: GameMode;
  games_played: number;
  games_won: number;
  total_peels: number;
  total_dumps: number;
  total_words: number;
  total_word_length: number;
  longest_word: string | null;
  longest_word_length: number;
  fastest_peel_ms: number | null;
  rarest_word: string | null;
  rarest_word_score: number;
  best_peel_streak: number;
  first_letter_counts: Record<string, number>;
}
```

- [ ] **Step 2: Update `aggregateStats()`**

Replace the whole function body (same file) with the choke sum removed and the two new fields
merged in (`best_peel_streak` via `Math.max`, mirroring `fastest_peel_ms`'s `Math.min`;
`first_letter_counts` via per-letter sum, mirroring how `first_letters` used to union):

```ts
function aggregateStats(rows: ProfileStatsRow[]): ProfileStatsRow | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];

  let longest: ProfileStatsRow['longest_word'] = null;
  let longestLen = 0;
  let rarest: ProfileStatsRow['rarest_word'] = null;
  let rarestScore = 0;
  let fastestPeel: number | null = null;
  let bestStreak = 0;
  const letterCounts: Record<string, number> = {};
  for (const r of rows) {
    if (r.longest_word_length > longestLen) {
      longestLen = r.longest_word_length;
      longest = r.longest_word;
    }
    if (r.rarest_word_score > rarestScore) {
      rarestScore = r.rarest_word_score;
      rarest = r.rarest_word;
    }
    if (r.fastest_peel_ms != null && (fastestPeel == null || r.fastest_peel_ms < fastestPeel)) {
      fastestPeel = r.fastest_peel_ms;
    }
    bestStreak = Math.max(bestStreak, r.best_peel_streak);
    for (const [letter, count] of Object.entries(r.first_letter_counts)) {
      letterCounts[letter] = (letterCounts[letter] ?? 0) + count;
    }
  }

  return {
    profile_id: rows[0].profile_id,
    mode: 'multiplayer', // placeholder — callers requesting the aggregate ignore this field
    games_played: rows.reduce((sum, r) => sum + r.games_played, 0),
    games_won: rows.reduce((sum, r) => sum + r.games_won, 0),
    total_peels: rows.reduce((sum, r) => sum + r.total_peels, 0),
    total_dumps: rows.reduce((sum, r) => sum + r.total_dumps, 0),
    total_words: rows.reduce((sum, r) => sum + r.total_words, 0),
    total_word_length: rows.reduce((sum, r) => sum + r.total_word_length, 0),
    longest_word: longest,
    longest_word_length: longestLen,
    fastest_peel_ms: fastestPeel,
    rarest_word: rarest,
    rarest_word_score: rarestScore,
    best_peel_streak: bestStreak,
    first_letter_counts: letterCounts,
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: fails here (Task 5 hasn't updated `StatsBoard` yet, which still references the removed
`choke_count`/`first_letters` fields) — that's expected at this point in the plan. Confirm the
*only* errors are in `Profile.tsx` referencing those two removed fields; anything else is a real
problem to stop and fix.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/profile.ts
git commit -m "$(cat <<'EOF'
feat(web): update ProfileStatsRow for peel-streak/favorite-letter stats

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: StatsBoard tiles

**Files:**
- Modify: `apps/web/src/pages/Profile.tsx:467-520` (`StatsBoard`)

**Interfaces:**
- Consumes: `ProfileStatsRow` (Task 4) — specifically `best_peel_streak: number` and
  `first_letter_counts: Record<string, number>`.

- [ ] **Step 1: Replace the `StatsBoard` function body**

Replace the whole function (same signature) with the choke rate calc removed and the two new
tiles added:

```tsx
function StatsBoard({ stats, streak, filter, onFilterChange, locked = false }: StatsBoardProps) {
  const filterOptions: { id: StatsFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'multiplayer', label: 'Multiplayer' },
    { id: 'solo', label: 'Solo' },
  ];

  const modeSelector = locked ? null : (
    <div className="segmented">
      {filterOptions.map((o) => (
        <button
          key={o.id}
          className={`segmented-option${filter === o.id ? ' selected' : ''}`}
          onClick={() => onFilterChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );

  if (!stats || stats.games_played === 0) {
    return (
      <div className="panel profile-panel">
        {modeSelector}
        <p className="hint">Play a game to start building your stats!</p>
      </div>
    );
  }
  const avgLen = stats.total_words > 0 ? (stats.total_word_length / stats.total_words).toFixed(1) : '-';
  const winRate = stats.games_played > 0 ? Math.round((stats.games_won / stats.games_played) * 100) : 0;
  // Peel streak is multiplayer-only by definition (best_peel_streak is never set for solo/xtina
  // rows), so it's hidden on the solo filter alongside win rate — see the 2026-08-08 spec.
  const showCompetitiveStats = filter !== 'solo';
  const fastestPeel = stats.fastest_peel_ms != null ? `${(stats.fastest_peel_ms / 1000).toFixed(1)}s` : '-';

  const letterEntries = Object.entries(stats.first_letter_counts);
  const maxLetterCount = letterEntries.reduce((max, [, count]) => Math.max(max, count), 0);
  const favoriteLetters = maxLetterCount > 0
    ? letterEntries.filter(([, count]) => count === maxLetterCount).map(([letter]) => letter).sort().join(', ')
    : '-';

  const tiles: { label: string; value: string | number }[] = [
    { label: 'Games played', value: stats.games_played },
    ...(showCompetitiveStats ? [{ label: 'Wins', value: `${stats.games_won} (${winRate}%)` }] : []),
    ...(streak ? [{ label: 'Current streak', value: streak.current }, { label: 'Longest streak', value: streak.longest }] : []),
    { label: 'Longest word', value: stats.longest_word ?? '-' },
    { label: 'Rarest word', value: stats.rarest_word ?? '-' },
    { label: 'Avg word length', value: avgLen },
    { label: 'Fastest peel', value: fastestPeel },
    { label: 'Tiles peeled', value: stats.total_peels },
    { label: 'Tiles dumped', value: stats.total_dumps },
    { label: 'Favorite starting letter', value: favoriteLetters },
    ...(showCompetitiveStats
      ? [{ label: 'Best peel streak', value: stats.best_peel_streak > 0 ? stats.best_peel_streak : '-' }]
      : []),
  ];

  return (
    <div className="panel profile-panel">
      {modeSelector}
      <div className="stats-grid">
        {tiles.map((t) => (
          <div key={t.label} className="stat-tile">
            <span className="stat-value">{t.value}</span>
            <span className="stat-label">{t.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck (should now pass clean)**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Manual browser verification**

1. Ensure the local stack is up to date: `npm run db:reset` (already done in earlier tasks, but
   re-run if anything changed).
2. Start the app: use `preview_start` with the `dev:web` (and `dev:api`) launch config, or
   `npm run dev:web` / `npm run dev:api` if driving the browser manually.
3. Sign in, play one multiplayer game to a real Plantains finish (two browser sessions or two
   tabs), doing at least 3 consecutive Peels before a Dump at some point.
4. Open Profile → Stats. Confirm: no "Alphabet letters" or "Choke rate" tiles anywhere. "Favorite
   starting letter" shows a letter (or comma-joined letters if tied). "Best peel streak" shows a
   number ≥ 3, and disappears when the Solo filter pill is selected.
5. Play one solo game. Confirm "Best peel streak" does not appear when filtered to Solo (or when
   Solo is the only mode with data and the "All" view — since the solo row's `best_peel_streak`
   stays 0 — the tile in "All" should reflect only the multiplayer contribution).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/Profile.tsx
git commit -m "$(cat <<'EOF'
feat(web): replace choke rate & alphabet letters with peel streak & favorite letter

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Final full verification

**Files:** none (verification only)

- [ ] **Step 1: Full local reset + full smoke suite**

```bash
npm run db:reset
node scripts/smoke-stats-tiles.mjs
node scripts/smoke-xtina.mjs
node scripts/smoke-guest-sweep.mjs
```

Expected: every script prints only `ok` lines, no `FAIL`, no uncaught errors. Running the other
two existing smoke scripts alongside the new one confirms nothing in this change broke xtina mode
or the guest sweep (both touch `profile_stats`/`profiles` in ways that could collide).

- [ ] **Step 2: Full workspace typecheck + shared build**

```bash
npm run build:shared
npm run test:shared
cd apps/web && npx tsc --noEmit -p tsconfig.json
```

Expected: all pass clean.

- [ ] **Step 3: Report the new migration file for manual prod application**

This plan's migration (`supabase/migrations/20260808000002_stats_peel_streak_favorite_letter.sql`)
is now complete across Tasks 1-3. Per this repo's deployment convention, it is **not** auto-applied
to prod — paste its contents into the Supabase Studio SQL editor (copy from the file, not from any
chat transcript, per the CLAUDE.md dollar-quoting warning) once this plan's tasks are all merged
and pushed.
