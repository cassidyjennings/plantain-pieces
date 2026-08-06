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

  await client.end();
  console.log('\nall smoke checks passed');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
