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
    `select public._best_peel_streak($1, $2, now() + interval '10 seconds') as s`, [roomId, profile],
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
