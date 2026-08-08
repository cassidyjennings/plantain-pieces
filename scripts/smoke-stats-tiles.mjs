// scripts/smoke-stats-tiles.mjs
// Scripted smoke test for stats helpers and archive_game integration against the LOCAL supabase stack.
// Run from the repo root:  node scripts/smoke-stats-tiles.mjs
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
    `select public._best_peel_streak($1, $2, now() + interval '10 seconds') as s`, [roomId, profile],
  )).rows[0].s;
  assert(noEvents === 0, 'no events after the cutoff yields 0, not null or an error');

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
    `select best_peel_streak
       from public.profile_stats where profile_id = $1 and mode = 'multiplayer'`,
    [owner],
  )).rows[0];
  assert(mpStat.best_peel_streak === 3, 'multiplayer game rolls up a best_peel_streak of 3');

  const chokeGone = await client.query(
    `select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'profile_stats' and column_name = 'choke_count'`,
  );
  assert(chokeGone.rowCount === 0, 'choke_count column no longer exists');

  console.log('\nsubmit_game_summary: first_letter_counts + xtina guard');

  await client.query(
    `update public.room_players set rack = '[]'::jsonb, summary_applied = false where room_id = $1 and profile_id = $2`,
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
  await client.end();
}

main().catch((err) => {
  console.error(err);
  client.end();
  process.exit(1);
});
