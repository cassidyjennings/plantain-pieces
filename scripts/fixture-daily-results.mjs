// scripts/fixture-daily-results.mjs
// Builds a FINISHED daily-puzzle room owned by the given profile, against the LOCAL stack only, so
// the daily Results page can be checked in the browser without solving a puzzle by hand.
//
//   node scripts/fixture-daily-results.mjs --profile=<uuid> --date=YYYY-MM-DD [--others=3] [--no-pb] [--ms=123000]
//
// --profile  the browser tab's own guest id (anonymous auth is per-tab, so never guess "newest guest")
// --date     the tab's LOCAL date; create_daily_room accepts UTC today +-1
// --others   other solvers to seed for this puzzle (default 3 -> 2 slower, 1 faster = "67%").
//            0 deletes every other daily_results row for the puzzle -> "First!" (local data only).
// --no-pb    pre-seeds a faster personal best (60s) so the "Personal Best" badge must NOT show
// --ms       this solve's duration (default 123000 = "2:03")
import pg from 'pg';

const DB = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB)) {
  console.error('Refusing to run: this fixture writes test rows and only targets the LOCAL stack.');
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);
const profileId = args.profile;
const date = args.date;
const others = Number(args.others ?? 3);
const noPb = args['no-pb'] === 'true';
const durationMs = Number(args.ms ?? 123000);
if (!profileId || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !Number.isInteger(others) || others < 0) {
  console.error(
    'usage: node scripts/fixture-daily-results.mjs --profile=<uuid> --date=YYYY-MM-DD [--others=3] [--no-pb] [--ms=123000]',
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: DB });

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

  // Prefer a real scheduled puzzle for that date; otherwise make a TEST one (first_word = 'TEST' is
  // the same cleanup marker scripts/smoke-daily-stats.mjs uses).
  let puzzle = (
    await client.query(
      `select id from public.daily_puzzles
        where status = 'scheduled' and scheduled_date = $1::date and language = 'en' limit 1`,
      [date],
    )
  ).rows[0];
  if (!puzzle) {
    puzzle = (
      await client.query(
        `insert into public.daily_puzzles
           (language, letter_multiset, grid_state, dictionary_config, floor_score, spread_score,
            distinct_board_count, replay_run_count, status, scheduled_date, generation_seed, first_word)
         values ('en', 'AELPST', '{}'::jsonb,
                 '{"minLength":2,"maxLength":null,"baseEnabled":true,"excludedTopics":[],"customSetIds":[]}'::jsonb,
                 1.0, 0.5, 1, 1, 'scheduled', $1::date, 1, 'TEST')
         returning id`,
        [date],
      )
    ).rows[0];
  }

  // Idempotent reruns: daily_results is unique per (puzzle, profile).
  await client.query(`delete from public.daily_results where puzzle_id = $1 and profile_id = $2`, [
    puzzle.id,
    profileId,
  ]);
  if (others === 0) {
    await client.query(`delete from public.daily_results where puzzle_id = $1`, [puzzle.id]);
  }

  // Personal best: archive_game sets daily_best_time_ms = least(existing, this run). Clearing it
  // makes this run the best (badge shows); seeding 60s first makes this run slower (no badge).
  await client.query(
    `insert into public.profile_stats (profile_id, mode, daily_best_time_ms)
       values ($1, 'daily', $2)
     on conflict (profile_id, mode) do update set daily_best_time_ms = excluded.daily_best_time_ms`,
    [profileId, noPb ? 60000 : null],
  );

  const room = (
    await client.query(`select public.create_daily_room($1, 'Fixture Tester', $2::date) as r`, [
      profileId,
      date,
    ])
  ).rows[0].r;
  const roomId = room.roomId;

  // PLATES across row 20: a valid word, so the Longest word tile has something to show.
  const grid = { '20,20': 'P', '21,20': 'L', '22,20': 'A', '23,20': 'T', '24,20': 'E', '25,20': 'S' };
  await client.query(
    `update public.room_players set grid_state = $1::jsonb where room_id = $2 and profile_id = $3`,
    [JSON.stringify(grid), roomId, profileId],
  );
  await client.query(
    `update public.rooms
        set status = 'finished',
            started_at = now() - ($1 || ' milliseconds')::interval,
            finished_at = now(),
            winner_id = $2
      where id = $3`,
    [durationMs, profileId, roomId],
  );

  for (let i = 0; i < others; i++) {
    const other = await makeUser(`fixture-daily-${Date.now()}-${i}@example.test`);
    const ms = i % 3 === 2 ? Math.max(1000, durationMs - 23000) : durationMs + 60000 * (i + 1);
    await client.query(
      `insert into public.daily_results (puzzle_id, profile_id, duration_ms) values ($1, $2, $3)`,
      [puzzle.id, other, ms],
    );
  }

  await client.query(`select public.archive_game($1, $2)`, [roomId, profileId]);

  const { rows: cmp } = await client.query(
    `select count(*)::int as total,
            count(*) filter (where profile_id <> $2 and duration_ms > $3)::int as slower
       from public.daily_results where puzzle_id = $1`,
    [puzzle.id, profileId, durationMs],
  );
  const { total, slower } = cmp[0];
  const beat = total > 1 ? `${Math.round((slower / (total - 1)) * 100)}%` : 'First!';
  console.log(
    JSON.stringify({
      roomId,
      path: `/room/${roomId}/results`,
      expect: { time: `${Math.floor(durationMs / 60000)}:${String(Math.floor((durationMs % 60000) / 1000)).padStart(2, '0')}`, solversBeaten: beat, personalBest: !noPb },
    }),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => client.end());
