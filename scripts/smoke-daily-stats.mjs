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

  console.log('\narchive_game: daily branch writes daily_results + profile_stats');

  async function makeDailyPuzzle(daysFromToday) {
    const { rows } = await client.query(
      `insert into public.daily_puzzles
         (language, letter_multiset, grid_state, dictionary_config, floor_score, spread_score,
          distinct_board_count, replay_run_count, status, scheduled_date, generation_seed, first_word)
       values ('en', 'AAAABBBBCCCCDDDDEEEEFFFF', '{}'::jsonb,
               '{"minLength":2,"maxLength":null,"baseEnabled":true,"excludedTopics":[],"customSetIds":[]}'::jsonb,
               1.0, 0.5, 1, 1, 'scheduled', current_date + $1::int, 1, 'TEST')
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

  // create_daily_room only accepts a date within 1 day of the UTC "today" (the player's local
  // date can be one day either side of UTC) — so the puzzles used through create_daily_room
  // below must stay inside {yesterday, today, tomorrow}, not arbitrary future dates.
  const puzzleA = await makeDailyPuzzle(-1);
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
  const puzzleB = await makeDailyPuzzle(0);
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
