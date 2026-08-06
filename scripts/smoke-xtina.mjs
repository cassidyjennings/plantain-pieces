// Scripted smoke test for xtina mode against the LOCAL supabase stack.
// Run from the repo root:  node scripts/smoke-xtina.mjs
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

async function main() {
  await client.connect();
  console.log('roles + toggle');

  const owner = await makeUser(`owner-${Date.now()}@example.test`);
  const partner = await makeUser(`partner-${Date.now()}@example.test`);
  const bystander = await makeUser(`bystander-${Date.now()}@example.test`);

  await client.query(`update public.profiles set xtina_role = 'owner' where id = $1`, [owner]);
  await client.query(`update public.profiles set xtina_role = 'partner' where id = $1`, [partner]);

  let rejected = false;
  try {
    await client.query('select public.set_xtina_enabled($1, true)', [bystander]);
  } catch (err) {
    rejected = err.message.includes('NOT_XTINA_OWNER');
  }
  assert(rejected, 'a non-owner cannot arm the mode');

  await client.query('select public.set_xtina_enabled($1, true)', [owner]);
  const { rows } = await client.query('select xtina_enabled from public.profiles where id = $1', [owner]);
  assert(rows[0].xtina_enabled === true, 'the owner can arm the mode');

  await client.query('select public.set_xtina_enabled($1, false)', [owner]);
  const off = await client.query('select xtina_enabled from public.profiles where id = $1', [owner]);
  assert(off.rows[0].xtina_enabled === false, 'the owner can disarm the mode');

  const modeOk = await client.query(
    `select 1 from pg_constraint
      where conname = 'rooms_mode_check' and pg_get_constraintdef(oid) like '%xtina%'`,
  );
  assert(modeOk.rowCount === 1, "rooms.mode accepts 'xtina'");

  console.log('\nscripted deal');

  // The TS spec is the source of truth; assert the SQL twin agrees with it letter for letter.
  const { xtinaStepLetters, xtinaBunch, XTINA_STEPS, XTINA_OWNER_TILES } =
    await import('../packages/shared/dist/index.js');

  for (let step = 1; step <= XTINA_STEPS; step++) {
    const { rows } = await client.query('select public._xtina_step_letters($1) as letters', [step]);
    assert(
      JSON.stringify(rows[0].letters) === JSON.stringify(xtinaStepLetters(step)),
      `SQL step ${step} letters match the shared spec`,
    );
  }

  const sqlBunch = (await client.query('select public._xtina_bunch() as b')).rows[0].b;
  assert(
    JSON.stringify(Object.entries(sqlBunch).sort()) ===
      JSON.stringify(Object.entries(xtinaBunch()).sort()),
    'SQL bunch matches the shared spec',
  );

  for (let i = 1; i <= XTINA_OWNER_TILES.length; i++) {
    const t = (await client.query('select public._xtina_owner_tile($1) as t', [i])).rows[0].t;
    assert(t === XTINA_OWNER_TILES[i - 1], `SQL owner tile ${i} matches the shared spec`);
  }

  // Drive a full game: create room, join, Split, then nine Peels.
  await client.query('select public.set_xtina_enabled($1, true)', [owner]);
  const room = (await client.query(
    `select public.create_room($1, 'Owner', null) as r`, [owner],
  )).rows[0].r;
  const roomId = room.roomId ?? room.room_id ?? room.id;
  await client.query(`select public.join_room($1, $2, 'Partner', false)`, [room.code, partner]);
  await client.query('select public.start_game($1, $2)', [roomId, owner]);

  let r = (await client.query(
    'select mode, mode_config, bunch_count from public.rooms where id = $1', [roomId],
  )).rows[0];
  assert(r.mode === 'xtina', 'Split routes to the scripted path');
  assert(r.mode_config.step === 1, 'the script starts at step 1');
  assert(r.bunch_count === 60, 'the bunch reads 60 after Split');

  const rackOf = async (id) => (await client.query(
    'select rack, tile_count from public.room_players where room_id = $1 and profile_id = $2',
    [roomId, id],
  )).rows[0];

  let pRack = await rackOf(partner);
  assert(JSON.stringify(pRack.rack) === JSON.stringify(xtinaStepLetters(1)),
    'the partner is dealt YOURE at Split');
  let oRack = await rackOf(owner);
  assert(oRack.rack.every((t) => t === 'X' || t === 'Z'), 'the owner is dealt only X and Z');
  assert(oRack.tile_count === pRack.tile_count,
    'both players show the same tile count at Split (no asymmetry tell)');

  for (let step = 2; step <= XTINA_STEPS; step++) {
    const before = await rackOf(partner);
    await client.query('select public.peel($1, $2, $3)', [roomId, partner, before.tile_count]);
    const after = await rackOf(partner);
    const dealt = after.rack.slice(before.rack.length);
    assert(JSON.stringify(dealt) === JSON.stringify(xtinaStepLetters(step)),
      `peel to step ${step} deals exactly that word's letters`);
  }

  r = (await client.query('select bunch_count, mode_config from public.rooms where id = $1', [roomId])).rows[0];
  assert(r.bunch_count === 0, 'the bunch lands on exactly 0 after the final peel');
  assert(r.mode_config.step === 10, 'the script ends at step 10');

  const finalPartner = await rackOf(partner);
  assert(finalPartner.tile_count === 56, 'the partner has been dealt all 56 tiles');
  const finalOwner = await rackOf(owner);
  assert(finalOwner.tile_count === 14, 'the owner has been dealt all 14 junk tiles');

  // One more peel must be impossible — this is what forces the client to fire Plantains.
  let tooLow = false;
  try {
    await client.query('select public.peel($1, $2, $3)', [roomId, partner, finalPartner.tile_count]);
  } catch (err) {
    tooLow = err.message.includes('BUNCH_TOO_LOW');
  }
  assert(tooLow, 'an eleventh peel is refused with BUNCH_TOO_LOW');

  // An unarmed owner must get an ordinary random game.
  await client.query('select public.set_xtina_enabled($1, false)', [owner]);
  const plain = (await client.query(`select public.create_room($1, 'Owner', null) as r`, [owner])).rows[0].r;
  const plainId = plain.roomId ?? plain.room_id ?? plain.id;
  await client.query(`select public.join_room($1, $2, 'Partner', false)`, [plain.code, partner]);
  await client.query('select public.start_game($1, $2)', [plainId, owner]);
  const plainRoom = (await client.query('select mode, bunch_count from public.rooms where id = $1', [plainId])).rows[0];
  assert(plainRoom.mode === 'multiplayer', 'a disarmed owner gets an ordinary game');
  assert(plainRoom.bunch_count === 144 - 42, 'the ordinary game deals 21 tiles each from a 144 bunch');

  await client.end();
  console.log('\nall smoke checks passed');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
