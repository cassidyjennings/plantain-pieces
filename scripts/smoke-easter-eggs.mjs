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

async function playersSeenBy(uid, roomId) {
  return asUser(
    uid,
    `select profile_id, tile_count, remaining_count, ghosted from public.room_players_public where room_id = $1`,
    [roomId],
  );
}

async function sectionGhost() {
  const { roomId, host, guest } = await startedRoom('ghost-host', 'ghost-guest');
  await q(`select public.report_progress($1, $2, 7)`, [roomId, host]);

  let seen = await playersSeenBy(guest, roomId);
  let h = seen.find((r) => r.profile_id === host);
  assert(h.tile_count === 21 && h.remaining_count === 7 && h.ghosted === false, 'before GHOST: opponent sees real counts');

  await q(`select public.report_egg_flags($1, $2, '{"ghosted": true}'::jsonb)`, [roomId, host]);
  const events = await q(
    `select payload from public.room_events where room_id = $1 and type = 'progress' and payload ->> 'ghosted' = 'true'`,
    [roomId],
  );
  assert(events.length === 1, 'GHOST appends one progress event');
  assert(!('remaining' in events[0].payload) && !('tileCount' in events[0].payload), 'the event carries no counts');

  await q(`select public.report_egg_flags($1, $2, '{"ghosted": true}'::jsonb)`, [roomId, host]);
  const again = await one(
    `select count(*)::int as n from public.room_events where room_id = $1 and type = 'progress' and payload ->> 'ghosted' = 'true'`,
    [roomId],
  );
  assert(again.n === 1, 'a repeat GHOST report is a no-op (no second event)');


  seen = await playersSeenBy(guest, roomId);
  h = seen.find((r) => r.profile_id === host);
  const g = seen.find((r) => r.profile_id === guest);
  assert(h.tile_count === null && h.remaining_count === null && h.ghosted === true, 'opponent sees null counts for the ghosted player');
  assert(g.tile_count === 21 && g.ghosted === false, 'the non-ghosted player is unaffected');

  await q(`select public.report_egg_flags($1, $2, '{"ghosted": false}'::jsonb)`, [roomId, host]);
  const still = await one(`select ghosted from public.room_players where room_id = $1 and profile_id = $2`, [roomId, host]);
  assert(still.ghosted === true, 'GHOST lasts the rest of the game (no un-ghost path)');

  await q(`update public.rooms set status = 'finished', finished_at = now(), winner_id = $2 where id = $1`, [roomId, guest]);
  seen = await playersSeenBy(guest, roomId);
  h = seen.find((r) => r.profile_id === host);
  assert(h.tile_count === 21, 'finished room: the mask lifts');

  await q(`update public.rooms set win_kind = 'supercali' where id = $1`, [roomId]);
  await q(`update public.room_players set freeze_used = true where room_id = $1`, [roomId]);
  await q(`select public.rematch_room($1, $2)`, [roomId, guest]);
  const rp = await one(
    `select bool_or(ghosted) as g, bool_or(freeze_used) as f from public.room_players where room_id = $1`,
    [roomId],
  );
  assert(rp.g === false && rp.f === false, 'rematch_room clears ghosted and freeze_used');
  const rm = await one(`select win_kind from public.rooms where id = $1`, [roomId]);
  assert(rm.win_kind === null, 'rematch_room clears win_kind');

  await expectError(
    q(`select public.report_egg_flags($1, $2, '{"ghosted": true}'::jsonb)`, [roomId, host]),
    'GAME_NOT_ACTIVE',
    'report_egg_flags is refused outside an active game',
  );
  await expectError(
    q(`select public.report_egg_flags($1, $2, '{"ghosted": true}'::jsonb)`, [roomId, await makeUser('ghost-stranger')]),
    'GAME_NOT_ACTIVE',
    'a stranger hits the room-status gate first (room is in lobby)',
  );
}

async function sectionGhostEventLeak() {
  // [review] the ghost mask must hold in room_events too, not just room_players_public: every
  // event written after the GHOST latch is readable by room members.
  const { roomId, host, guest } = await startedRoom('leak-host', 'leak-guest');
  await q(`select public.report_egg_flags($1, $2, '{"ghosted": true}'::jsonb)`, [roomId, host]);
  const ghostEvt = await one(
    `select max(id) as id from public.room_events where room_id = $1 and payload ->> 'ghosted' = 'true'`,
    [roomId],
  );
  await q(`select public.report_progress($1, $2, 3)`, [roomId, host]);
  const hostRow = await one(`select tile_count, remaining_count from public.room_players where room_id = $1 and profile_id = $2`, [roomId, host]);
  assert(hostRow.remaining_count === 3, 'a ghosted report_progress still updates the row');
  await q(`select public.peel($1, $2, $3)`, [roomId, host, hostRow.tile_count]);
  const guestCount = (await one(`select tile_count from public.room_players where room_id = $1 and profile_id = $2`, [roomId, guest])).tile_count;
  await q(`select public.peel($1, $2, $3)`, [roomId, guest, guestCount]);
  const guestRack = (await one(`select rack from public.room_players where room_id = $1 and profile_id = $2`, [roomId, guest])).rack;
  await q(`select public.dump($1, $2, $3)`, [roomId, guest, guestRack[0]]);
  const after = await q(`select type, payload from public.room_events where room_id = $1 and id > $2 order by id`, [roomId, ghostEvt.id]);
  assert(after.some((e) => e.type === 'progress') && after.some((e) => e.type === 'peel') && after.some((e) => e.type === 'dump'),
    `post-GHOST progress, peel and dump events were written (${after.map((e) => e.type).join(',')})`);
  const leaks = after.filter((e) => {
    if (e.type === 'progress' && e.payload.profileId === host && 'remaining' in e.payload) return true;
    return (e.payload.tileCounts ?? []).some((t) => t.profileId === host && t.tileCount !== null);
  });
  assert(leaks.length === 0, `no post-GHOST room_events payload carries the ghosted player's counts (${JSON.stringify(leaks)})`);
  const guestVisible = after.filter((e) => e.type !== 'progress')
    .every((e) => (e.payload.tileCounts ?? []).some((t) => t.profileId === guest && typeof t.tileCount === 'number'));
  assert(guestVisible, "the non-ghosted player's tileCount stays in event payloads");
}

async function soloRoom(tag, timed) {
  // Built from create_room + a mode flip rather than create_solo_room, so this test does not
  // depend on create_solo_room's signature (Phase 3 touches solo room creation).
  const p = await makeUser(tag);
  const room = (await one(`select public.create_room($1, 'Solo', null) as r`, [p])).r;
  await q(`select public.start_game($1, $2)`, [room.roomId, p]);
  await q(`update public.rooms set mode = 'solo', mode_config = $2::jsonb where id = $1`, [
    room.roomId,
    { bunchSize: 144, timed },
  ]);
  return { roomId: room.roomId, p };
}

async function finishSoloAndReadBest(roomId, p) {
  await q(
    `update public.rooms set status = 'finished', finished_at = now(),
            started_at = now() - interval '70 seconds', winner_id = $2 where id = $1`,
    [roomId, p],
  );
  await q(`select public.archive_game($1, $2)`, [roomId, p]);
  return (await one(
    `select (solo_best_times ->> '144')::int as ms from public.profile_stats where profile_id = $1 and mode = 'solo'`,
    [p],
  )).ms;
}

async function sectionFreeze() {
  const a = await soloRoom('freeze-a', true);
  await q(`select public.report_egg_flags($1, $2, '{"freezeUsed": true}'::jsonb)`, [a.roomId, a.p]);
  const fa = await one(`select freeze_used from public.room_players where room_id = $1`, [a.roomId]);
  assert(fa.freeze_used === true, 'Timed solo: FREEZE is recorded');
  assert((await finishSoloAndReadBest(a.roomId, a.p)) === 60000, 'FREEZE: 70 s of wall clock archives as 60000 ms');

  const b = await soloRoom('freeze-b', true);
  assert((await finishSoloAndReadBest(b.roomId, b.p)) === 70000, 'control: no FREEZE archives the full 70000 ms');

  const zen = await soloRoom('freeze-zen', false);
  await q(`select public.report_egg_flags($1, $2, '{"freezeUsed": true}'::jsonb)`, [zen.roomId, zen.p]);
  const fz = await one(`select freeze_used from public.room_players where room_id = $1`, [zen.roomId]);
  assert(fz.freeze_used === false, 'Zen solo: FREEZE is ignored');

  const mp = await startedRoom('freeze-mp-host', 'freeze-mp-guest');
  await q(`select public.report_egg_flags($1, $2, '{"freezeUsed": true}'::jsonb)`, [mp.roomId, mp.host]);
  const fm = await one(`select freeze_used from public.room_players where room_id = $1 and profile_id = $2`, [mp.roomId, mp.host]);
  assert(fm.freeze_used === false, 'multiplayer: FREEZE is ignored (rankings stay fair)');

  // [review] GHOST hides counts from opponents — only meaningful (and only accepted) in multiplayer.
  const gs = await soloRoom('ghost-solo', false);
  await q(`select public.report_egg_flags($1, $2, '{"ghosted": true}'::jsonb)`, [gs.roomId, gs.p]);
  const gsr = await one(`select ghosted from public.room_players where room_id = $1`, [gs.roomId]);
  assert(gsr.ghosted === false, 'solo: GHOST is ignored');
  const gx = await startedRoom('ghost-x-host', 'ghost-x-guest');
  await q(`update public.rooms set mode = 'xtina' where id = $1`, [gx.roomId]);
  await q(`select public.report_egg_flags($1, $2, '{"ghosted": true}'::jsonb)`, [gx.roomId, gx.host]);
  const gxr = await one(`select ghosted from public.room_players where room_id = $1 and profile_id = $2`, [gx.roomId, gx.host]);
  assert(gxr.ghosted === false, 'xtina: GHOST is ignored');
  const gxe = await one(`select count(*)::int as n from public.room_events where room_id = $1 and type = 'progress'`, [gx.roomId]);
  assert(gxe.n === 0, 'an ignored GHOST broadcasts nothing');
  const gsp = await startedRoom('ghost-spec-host', 'ghost-spec-guest');
  await q(`update public.room_players set is_spectator = true where room_id = $1 and profile_id = $2`, [gsp.roomId, gsp.guest]);
  await q(`select public.report_egg_flags($1, $2, '{"ghosted": true}'::jsonb)`, [gsp.roomId, gsp.guest]);
  const gspr = await one(`select ghosted from public.room_players where room_id = $1 and profile_id = $2`, [gsp.roomId, gsp.guest]);
  assert(gspr.ghosted === false, 'a spectator cannot GHOST');
}

async function sectionSupercali() {
  const WORD = rowGrid(SUPERCALI, 5, 10);
  async function roomWithRack(tag, rack) {
    const r = await startedRoom(`${tag}-host`, `${tag}-guest`);
    await q(
      `update public.room_players set rack = $3::jsonb, tile_count = jsonb_array_length($3::jsonb)
         where room_id = $1 and profile_id = $2`,
      [r.roomId, r.host, JSON.stringify(rack)],
    );
    return r;
  }
  const win = (r, grid, who = r.host) =>
    one(`select public.supercali_win($1, $2, $3::jsonb) as r`, [r.roomId, who, grid]);

  const short = await roomWithRack('sc-short', [...SUPERCALI].slice(1));
  await expectError(win(short, WORD), 'EXTRA_TILES', 'letters not in the rack are refused');

  const r = await roomWithRack('sc', [...SUPERCALI, 'Q', 'I']);
  await expectError(win(r, { ...WORD, ...rowGrid('QI', 5, 20) }), 'NOT_CONNECTED', 'a disconnected grid is refused');
  await expectError(win(r, rowGrid('QI', 5, 20)), 'NO_SUPERCALI', 'a grid without the word is refused');
  await expectError(win(r, { ...WORD, '39,10': 'I' }), 'NO_SUPERCALI', 'the word inside a longer run does not count');
  await expectError(win(r, { 'a,b': 'S' }), 'MALFORMED_GRID', 'malformed cell keys are refused');
  await expectError(win(r, WORD, await makeUser('sc-stranger')), 'NOT_IN_ROOM', 'a non-member is refused');
  const mid = await one(`select status, bunch_count from public.rooms where id = $1`, [r.roomId]);
  assert(mid.status === 'active', 'refusals leave the room active');
  assert(mid.bunch_count > 2, `the Bunch is nowhere near low (${mid.bunch_count}) — the win below bypasses that gate`);

  const ok = (await win(r, WORD)).r;
  assert(ok.ok === true && ok.supercali === true, 'supercali_win accepts the word with tiles still in hand');
  const room = await one(`select status, winner_id, win_kind from public.rooms where id = $1`, [r.roomId]);
  assert(room.status === 'finished' && room.winner_id === r.host && room.win_kind === 'supercali', 'room finished, caller wins, win_kind = supercali');
  const saved = await one(`select grid_state from public.room_players where room_id = $1 and profile_id = $2`, [r.roomId, r.host]);
  assert(Object.keys(saved.grid_state).length === 34, 'the winning board is saved for the post-game viewer');
  assert(await hasAchievement(r.host, 'practically_perfect'), 'practically_perfect unlocked for the winner');
  assert(!(await hasAchievement(r.guest, 'practically_perfect')), 'practically_perfect not unlocked for the loser');
  const pub = await asUser(r.guest, `select win_kind from public.rooms_public where id = $1`, [r.roomId]);
  assert(pub[0].win_kind === 'supercali', 'rooms_public exposes win_kind to room members');
  await expectError(win(r, WORD), 'GAME_NOT_ACTIVE', 'a finished room cannot be won again');
}

async function sectionMysteryAchievements() {
  const summary = (words, eggs) => ({
    words,
    placedCount: 3,
    moveStats: { peelEfficiency: null, idleTileRatio: null, dumpRegret: 0 },
    eggs_found: eggs,
  });
  const submit = (roomId, uid, s) =>
    q(`select public.submit_game_summary($1, $2, $3::jsonb)`, [roomId, uid, JSON.stringify(s)]);
  const eggsOf = async (uid) => (await one(`select eggs_found from public.profiles where id = $1`, [uid])).eggs_found;

  const r1 = await startedRoom('egg-host', 'egg-guest');
  const me = r1.host;
  await submit(r1.roomId, me, summary(['MIT'], ['MIT', 'ghost', 'NOTANEGG', 42]));
  assert(JSON.stringify(await eggsOf(me)) === JSON.stringify(['GHOST', 'MIT']), 'eggs_found persisted: uppercased, deduped, non-egg strings dropped');
  assert(await hasAchievement(me, 'egg_hunter'), 'egg_hunter unlocked by any egg');
  assert(await hasAchievement(me, 'mind_and_hand'), 'mind_and_hand unlocked by MIT');
  assert(!(await hasAchievement(me, 'collector')), 'collector not yet (2 of 4)');

  await submit(r1.roomId, me, summary([], [SUPERCALI, 'FREEZE']));
  assert((await eggsOf(me)).length === 2, 'a resubmitted summary for the same room changes nothing (summary_applied)');

  const room2 = (await one(`select public.create_room($1, 'Host', null) as r`, [me])).r;
  await q(`select public.start_game($1, $2)`, [room2.roomId, me]);
  await submit(room2.roomId, me, summary([SUPERCALI], [SUPERCALI, 'FREEZE']));
  assert(
    JSON.stringify(await eggsOf(me)) === JSON.stringify(['FREEZE', 'GHOST', 'MIT', SUPERCALI]),
    'a second game accumulates eggs_found across rooms',
  );
  assert(await hasAchievement(me, 'collector'), 'collector unlocked once every egg in the list is found');
  // [review] room2 was NOT won via supercali_win, so a reported SUPERCALI word is a spoof: it must
  // not land in lifetime word stats (eggs_found above still accepts it — spoofable by spec).
  const st = await one(`select longest_word from public.profile_stats where profile_id = $1 and mode = 'multiplayer'`, [me]);
  assert(st.longest_word !== SUPERCALI, `a spoofed SUPERCALI word does not set longest_word (got ${st.longest_word})`);

  // [review] a genuine supercali_win winner's summary DOES count it.
  const real = await startedRoom('sc-real-host', 'sc-real-guest');
  await q(
    `update public.room_players set rack = $3::jsonb, tile_count = 34 where room_id = $1 and profile_id = $2`,
    [real.roomId, real.host, JSON.stringify([...SUPERCALI])],
  );
  await q(`select public.supercali_win($1, $2, $3::jsonb)`, [real.roomId, real.host, rowGrid(SUPERCALI, 5, 10)]);
  await submit(real.roomId, real.guest, summary([SUPERCALI, 'GHOST'], []));
  const loser = await one(`select longest_word from public.profile_stats where profile_id = $1 and mode = 'multiplayer'`, [real.guest]);
  assert(loser.longest_word === 'GHOST', `the LOSER of a supercali game cannot claim the word (an ordinary word still counts) (got ${loser.longest_word})`);
  await submit(real.roomId, real.host, summary([SUPERCALI], []));
  const winner = await one(`select longest_word from public.profile_stats where profile_id = $1 and mode = 'multiplayer'`, [real.host]);
  assert(winner.longest_word === SUPERCALI, 'the genuine supercali winner gets the 34-letter word in stats');

  await submit(r1.roomId, r1.guest, summary(['CAT'], []));
  assert((await eggsOf(r1.guest)).length === 0 && !(await hasAchievement(r1.guest, 'egg_hunter')), 'no eggs: nothing persisted, no egg_hunter');

  const hidden = await asUser(r1.guest, `select * from public.profiles_public where id = $1`, [me]);
  assert(hidden.length === 1 && !('eggs_found' in hidden[0]), 'eggs_found is not exposed through profiles_public');
  const others = await asUser(r1.guest, `select eggs_found from public.profiles where id = $1`, [me]);
  assert(others.length === 0, "another account cannot read a profile's eggs_found (profiles_select_own)");

  // speedrun — server-measured daily duration < 60 s.
  await q(`delete from public.daily_results where puzzle_id in (select id from public.daily_puzzles where first_word = 'EGGS')`);
  await q(`delete from public.daily_puzzles where first_word = 'EGGS'`);
  const puzzle = await one(
    `insert into public.daily_puzzles
       (language, letter_multiset, grid_state, dictionary_config, floor_score, spread_score,
        distinct_board_count, replay_run_count, status, scheduled_date, generation_seed, first_word)
     values ('en', 'AAAABBBBCCCCDDDDEEEEFFFF', '{}'::jsonb,
             '{"minLength":2,"maxLength":null,"baseEnabled":true,"excludedTopics":[],"customSetIds":[]}'::jsonb,
             1.0, 0.5, 1, 1, 'available', current_date + 41, 1, 'EGGS')
     returning id`,
  );
  async function dailyGame(tag, ms) {
    const p = await makeUser(tag);
    const room = (await one(`select public.create_room($1, 'Daily', null) as r`, [p])).r;
    await q(`select public.start_game($1, $2)`, [room.roomId, p]);
    await q(
      `update public.rooms set mode = 'daily', mode_config = $2::jsonb, status = 'finished',
              finished_at = now(), started_at = now() - ($3::int * interval '1 millisecond'), winner_id = $4
        where id = $1`,
      [room.roomId, { puzzleId: puzzle.id }, ms, p],
    );
    await q(`select public.archive_game($1, $2)`, [room.roomId, p]);
    return p;
  }
  assert(await hasAchievement(await dailyGame('speed-fast', 45000), 'speedrun'), 'speedrun: daily solved in 45 s');
  assert(!(await hasAchievement(await dailyGame('speed-edge', 60000), 'speedrun')), 'speedrun: exactly 60 s does not count (< 60 s)');
  assert(!(await hasAchievement(await dailyGame('speed-slow', 75000), 'speedrun')), 'speedrun: 75 s does not count');
}

const SECTIONS = [sectionEggValidation, sectionGhost, sectionGhostEventLeak, sectionFreeze, sectionSupercali, sectionMysteryAchievements];

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
