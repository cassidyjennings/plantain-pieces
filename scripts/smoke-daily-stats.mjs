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

  // Idempotent rerun: daily_puzzles enforces one scheduled row per (language, date), and this
  // script's puzzles are pinned to {yesterday, today, tomorrow} (the only dates create_daily_room
  // accepts) — so a second run without an intervening `db:reset` would collide with the previous
  // run's rows. Clean up only this script's own rows (marked by first_word = 'TEST'), never a
  // real puzzle.
  await client.query(
    `delete from public.daily_results where puzzle_id in
       (select id from public.daily_puzzles where first_word = 'TEST')`,
  );
  await client.query(`delete from public.daily_puzzles where first_word = 'TEST'`);

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
  const puzzleC = await makeDailyPuzzle(1);
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
