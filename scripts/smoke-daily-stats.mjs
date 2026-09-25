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

  console.log('\nAll smoke-daily-stats checks passed.');
  await client.end();
}

main().catch((err) => {
  console.error(err);
  client.end();
  process.exit(1);
});
