// scripts/smoke-easter-eggs.mjs
// Scripted smoke test for Phase 4 (easter eggs + mystery achievements) against the LOCAL stack.
// Run from the repo root, after `npm run build:shared` and `npx supabase migration up --local`:
//   node scripts/smoke-easter-eggs.mjs           # every section
//   node scripts/smoke-easter-eggs.mjs ghost     # only sections whose name contains "ghost"
import pg from 'pg';
import { EASTER_EGG_WORDS, SUPERCALI } from '../packages/shared/dist/index.js';

const DB = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const client = new pg.Client({ connectionString: DB });
const RUN = Date.now();
let userSeq = 0;

function assert(cond, label) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`  ok  ${label}`);
}

async function expectError(promise, code, label) {
  try {
    await promise;
  } catch (e) {
    assert(String(e.message).includes(code), `${label} (got: ${e.message})`);
    return;
  }
  throw new Error(`FAIL: ${label} — expected ${code}, but the call succeeded`);
}

async function q(sql, params = []) {
  return (await client.query(sql, params)).rows;
}

async function one(sql, params = []) {
  return (await q(sql, params))[0];
}

async function makeUser(tag) {
  userSeq += 1;
  const row = await one(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                             email_confirmed_at, created_at, updated_at,
                             raw_app_meta_data, raw_user_meta_data, is_anonymous)
     values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
             'authenticated', $1, '', now(), now(), now(), '{}', '{}', false)
     returning id`,
    [`${tag}-${RUN}-${userSeq}@example.test`],
  );
  createdUsers.push(row.id);
  return row.id;
}

/** Every auth user this run created — removed (with everything hanging off them) by cleanup(). */
const createdUsers = [];

/** Remove everything this run created. Rooms first: rooms.host_id/winner_id are ON DELETE NO
 * ACTION, so a referenced profile can't be deleted while its room exists. room_players,
 * room_events, profiles, profile_stats and achievements all cascade from there. The daily
 * section's puzzle (first_word 'EGGS') and its daily_results go too. */
async function cleanup() {
  await client.query(
    `delete from public.daily_results where puzzle_id in (select id from public.daily_puzzles where first_word = 'EGGS')`,
  );
  if (createdUsers.length > 0) {
    await client.query(
      `delete from public.rooms where host_id = any($1::uuid[]) or winner_id = any($1::uuid[])`,
      [createdUsers],
    );
    await client.query(`delete from auth.users where id = any($1::uuid[])`, [createdUsers]);
  }
  await client.query(`delete from public.daily_puzzles where first_word = 'EGGS'`);
}

/** A started (status = 'active') two-player multiplayer room. */
async function startedRoom(hostTag = 'host', guestTag = 'guest') {
  const host = await makeUser(hostTag);
  const guest = await makeUser(guestTag);
  const room = (await one(`select public.create_room($1, 'Host', null) as r`, [host])).r;
  await q(`select public.join_room($1, $2, 'Guest', false)`, [room.code, guest]);
  await q(`select public.start_game($1, $2)`, [room.roomId, host]);
  return { roomId: room.roomId, code: room.code, host, guest };
}

/** One query as `uid` through the `authenticated` role, so RLS, auth.uid() and the
 * is_room_member() view filters apply exactly as they do for a real client. Rolled back. */
async function asUser(uid, sql, params = []) {
  await client.query('begin');
  try {
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: uid, role: 'authenticated' }),
    ]);
    await client.query('set local role authenticated');
    return (await client.query(sql, params)).rows;
  } finally {
    await client.query('rollback');
  }
}

/** A horizontal run of `word` starting at (x0, y), as a grid_state object. */
function rowGrid(word, x0, y) {
  const g = {};
  [...word].forEach((l, i) => {
    g[`${x0 + i},${y}`] = l;
  });
  return g;
}

async function hasAchievement(uid, type) {
  return !!(await one(`select 1 as x from public.achievements where user_id = $1 and type = $2`, [uid, type]));
}

async function invalidUnder(cfg, words) {
  return (await one(`select public._find_invalid_words_cfg($1::jsonb, $2::text[]) as inv`, [cfg, words])).inv;
}

async function sectionEggValidation() {
  const sqlWords = (await one(`select public._easter_egg_words() as w`)).w;
  assert(
    JSON.stringify(sqlWords) === JSON.stringify([...EASTER_EGG_WORDS]),
    '_easter_egg_words() matches packages/shared EASTER_EGG_WORDS (same words, same order)',
  );

  const restrictive = { minLength: 5, maxLength: null, baseEnabled: false, excludedTopics: [], customSetIds: [] };
  const inv = await invalidUnder(restrictive, ['MIT', 'GHOST', 'FREEZE', SUPERCALI, 'CAT', 'ZZZZZZ']);
  assert(
    JSON.stringify([...inv].sort()) === JSON.stringify(['CAT', 'ZZZZZZ']),
    'English off + minLength 5: every egg is valid (MIT despite length 3); CAT/ZZZZZZ are not',
  );

  const capped = { minLength: 2, maxLength: 4, baseEnabled: true, excludedTopics: [], customSetIds: [] };
  assert((await invalidUnder(capped, [SUPERCALI, 'FREEZE'])).length === 0, 'maxLength 4: the 34- and 6-letter eggs are still valid');

  assert((await invalidUnder(restrictive, ['mit'])).length === 0, 'egg matching is case-insensitive in SQL');

  const { roomId } = await startedRoom('val-host', 'val-guest');
  await q(`update public.rooms set dictionary_config = $2::jsonb where id = $1`, [roomId, restrictive]);
  const inv3 = (await one(`select public.find_invalid_words($1, $2::text[]) as inv`, [roomId, ['MIT', 'DOG']])).inv;
  assert(JSON.stringify(inv3) === JSON.stringify(['DOG']), 'find_invalid_words (the /validate + Plantains path) inherits egg acceptance');

  // The dictionary query's shape is load-bearing for index use (CLAUDE.md, 2026-07-28 entry).
  const src = (await one(`select prosrc from pg_proc where proname = '_find_invalid_words_cfg'`)).prosrc;
  const existsCount = (src.match(/exists\s*\(/gi) ?? []).length;
  assert(existsCount === 2, `dictionary query still has exactly two EXISTS blocks (found ${existsCount})`);
  assert(/from unnest\(v_candidates\)/i.test(src), 'dictionary query runs over the egg-stripped candidates array');
}

const SECTIONS = [sectionEggValidation];

async function main() {
  await client.connect();
  const filter = process.argv[2]?.toLowerCase();
  try {
    for (const section of SECTIONS) {
      if (filter && !section.name.toLowerCase().includes(filter)) continue;
      console.log(`\n${section.name}`);
      await section();
    }
    console.log('\nALL PASSED');
  } finally {
    await cleanup().catch((e) => console.error('cleanup failed:', e.message));
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
