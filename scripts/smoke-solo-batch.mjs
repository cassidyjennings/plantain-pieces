// scripts/smoke-solo-batch.mjs
// Scripted smoke test for solo peel batches (migration 20261006000003) against the LOCAL supabase
// stack. Run from the repo root:  node scripts/smoke-solo-batch.mjs
import pg from 'pg';

const DB = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const client = new pg.Client({ connectionString: DB });

function assert(cond, label) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`  ok  ${label}`);
}

/** Create a real auth user (the profiles trigger makes the profile row) and return its id. */
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

let userSeq = 0;
const createdUsers = [];
const freshUser = async () => {
  const id = await makeUser(`solo-batch-${Date.now()}-${userSeq++}@example.test`);
  createdUsers.push(id);
  return id;
};

/** Remove everything this run created. Rooms first: rooms.host_id/winner_id are ON DELETE NO
 * ACTION, so a referenced profile can't be deleted while its room exists. room_players,
 * room_events, profiles, profile_stats and achievements all cascade from there. */
async function cleanup() {
  if (createdUsers.length === 0) return;
  await client.query(
    `delete from public.rooms where host_id = any($1::uuid[]) or winner_id = any($1::uuid[])`,
    [createdUsers],
  );
  await client.query(`delete from auth.users where id = any($1::uuid[])`, [createdUsers]);
}

/** peelBatch === undefined -> the 5-argument call an old Worker makes (exercises the default). */
async function soloRoom(profile, bunchSize, peelBatch) {
  const r = peelBatch === undefined
    ? await client.query(`select public.create_solo_room($1, 'Solo', null, $2, false) as r`, [profile, bunchSize])
    : await client.query(`select public.create_solo_room($1, 'Solo', null, $2, false, $3) as r`,
        [profile, bunchSize, peelBatch]);
  return r.rows[0].r.roomId;
}

async function state(roomId, profile) {
  const { rows } = await client.query(
    `select r.bunch_count, r.mode_config, rp.tile_count, jsonb_array_length(rp.rack) as rack_len
       from public.rooms r join public.room_players rp on rp.room_id = r.id
      where r.id = $1 and rp.profile_id = $2`,
    [roomId, profile],
  );
  return rows[0];
}

async function peel(roomId, profile) {
  const s = await state(roomId, profile);
  return (await client.query('select public.peel($1, $2, $3) as r', [roomId, profile, s.tile_count])).rows[0].r;
}

async function lastPeelPayload(roomId) {
  const { rows } = await client.query(
    `select payload from public.room_events where room_id = $1 and type = 'peel' order by id desc limit 1`,
    [roomId],
  );
  return rows[0].payload;
}

async function peelRefused(roomId, profile) {
  try {
    await peel(roomId, profile);
    return false;
  } catch (err) {
    return err.message.includes('BUNCH_TOO_LOW');
  }
}

async function main() {
  await client.connect();

  console.log('signatures');
  const overloads = async (name) => (await client.query(
    `select count(*)::int as n from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [name],
  )).rows[0].n;
  assert(await overloads('create_solo_room') === 1, 'exactly one create_solo_room (no ambiguous overload)');
  assert(await overloads('peel') === 1, 'exactly one peel (no ambiguous overload)');
  const args = (await client.query(
    `select pg_get_function_identity_arguments('public.create_solo_room'::regproc) as a`,
  )).rows[0].a;
  assert(args.includes('p_peel_batch integer'), 'create_solo_room takes p_peel_batch');
  const anonCan = (await client.query(
    `select has_function_privilege('anon', 'public.create_solo_room(uuid,text,jsonb,int,boolean,int)', 'execute') as x`,
  )).rows[0].x;
  const svcCan = (await client.query(
    `select has_function_privilege('service_role', 'public.create_solo_room(uuid,text,jsonb,int,boolean,int)', 'execute') as x`,
  )).rows[0].x;
  assert(anonCan === false, 'anon cannot execute the recreated create_solo_room');
  assert(svcCan === true, 'service_role can execute the recreated create_solo_room');

  console.log('\nbatch draw + remainder on the last peel (bunch 40, batch 7)');
  const a = await freshUser();
  const roomA = await soloRoom(a, 40, 7);
  let s = await state(roomA, a);
  assert(s.mode_config.peelBatch === 7, 'mode_config.peelBatch is stored as 7');
  assert(s.bunch_count === 19 && s.tile_count === 21, 'opening deal is still 21 (bunch 40 -> 19)');
  await peel(roomA, a);
  s = await state(roomA, a);
  assert(s.bunch_count === 12 && s.tile_count === 28 && s.rack_len === 28, 'peel 1 draws 7 (bunch 12, 28 tiles)');
  let ev = await lastPeelPayload(roomA);
  assert(ev.drawn === 7 && ev.bunchCount === 12, 'peel event carries drawn = 7 and bunchCount = 12');
  await peel(roomA, a);
  s = await state(roomA, a);
  assert(s.bunch_count === 5 && s.tile_count === 35, 'peel 2 draws 7 (bunch 5, 35 tiles)');
  const last = await peel(roomA, a);
  s = await state(roomA, a);
  assert(s.bunch_count === 0 && s.tile_count === 40 && s.rack_len === 40, 'last peel takes the remaining 5');
  assert(last.bunchCount === 0 && last.rack.length === 40, 'peel return payload reflects the remainder draw');
  ev = await lastPeelPayload(roomA);
  assert(ev.drawn === 5, 'last peel event carries drawn = 5');
  assert(await peelRefused(roomA, a), 'an empty Bunch refuses the next peel with BUNCH_TOO_LOW');

  console.log('\ngate at bunch = 1 (bunch 40, batch 6)');
  const b = await freshUser();
  const roomB = await soloRoom(b, 40, 6);
  await peel(roomB, b);
  await peel(roomB, b);
  await peel(roomB, b);
  s = await state(roomB, b);
  assert(s.bunch_count === 1, 'three peels of 6 leave exactly 1 tile');
  await peel(roomB, b);
  s = await state(roomB, b);
  assert(s.bunch_count === 0 && s.tile_count === 40, 'a solo peel is allowed with 1 tile left and draws it');
  assert((await lastPeelPayload(roomB)).drawn === 1, 'that peel event carries drawn = 1');
  assert(await peelRefused(roomB, b), 'and the one after is refused');

  console.log('\nmissing / out-of-range peel batch');
  const c = await freshUser();
  const roomC = await soloRoom(c, 54, undefined);
  s = await state(roomC, c);
  assert(s.mode_config.peelBatch === 1, '5-argument call (old Worker) stores peelBatch = 1');
  await peel(roomC, c);
  s = await state(roomC, c);
  assert(s.bunch_count === 32 && s.tile_count === 22, 'and its peel draws exactly 1');

  for (const [input, expected] of [[null, 1], [0, 1], [-5, 1], [99, 7], [3, 3]]) {
    const u = await freshUser();
    const room = await soloRoom(u, 54, input);
    assert((await state(room, u)).mode_config.peelBatch === expected, `p_peel_batch ${input} is stored as ${expected}`);
  }

  const d = await freshUser();
  const roomD = await soloRoom(d, 54, 4);
  await client.query(`update public.rooms set mode_config = mode_config - 'peelBatch' where id = $1`, [roomD]);
  await peel(roomD, d);
  s = await state(roomD, d);
  assert(s.bunch_count === 32 && s.tile_count === 22, 'a pre-migration solo room (no peelBatch key) still peels 1');

  console.log('\nmultiplayer is unchanged');
  const host = await freshUser();
  const guest = await freshUser();
  const mp = (await client.query(`select public.create_room($1, 'Host', null) as r`, [host])).rows[0].r;
  const mpId = mp.roomId ?? mp.room_id ?? mp.id;
  await client.query(`select public.join_room($1, $2, 'Guest', false)`, [mp.code, guest]);
  await client.query('select public.start_game($1, $2)', [mpId, host]);
  s = await state(mpId, host);
  assert(s.bunch_count === 102, 'multiplayer deals 21 each from 144');
  await peel(mpId, host);
  const hs = await state(mpId, host);
  const gs = await state(mpId, guest);
  assert(hs.bunch_count === 100, 'one multiplayer peel removes exactly 2 tiles (1 per player)');
  assert(hs.tile_count === 22 && gs.tile_count === 22, 'each player received exactly 1 tile');
  assert((await lastPeelPayload(mpId)).drawn === 1, 'multiplayer peel event carries drawn = 1');

  console.log('\nall smoke checks passed');
}

main()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(async () => {
    try { await cleanup(); } catch (err) { console.error(`cleanup failed: ${err.message}`); process.exitCode = 1; }
    await client.end();
  });
