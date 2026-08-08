import pg from 'pg';

const DB = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const c = new pg.Client(DB);

const PREFIX = 'sweeptest';
let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
}

/** Create an anonymous auth user aged `days` days, plus its trigger-made profile. */
async function mkGuest(tag, days, { anonymous = true } = {}) {
  const { rows } = await c.query(
    `insert into auth.users (id, instance_id, aud, role, is_anonymous, created_at, updated_at,
                             raw_app_meta_data, raw_user_meta_data)
     values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
             'authenticated', $1, now() - make_interval(days => $2), now(), '{}', '{}')
     returning id`,
    [anonymous, days],
  );
  const id = rows[0].id;
  // profiles.created_at is defaulted to now() by the trigger; age it to match the auth user,
  // which is what the sweep's candidate scan actually reads.
  await c.query(
    `update public.profiles set created_at = now() - make_interval(days => $2),
                                display_name = $3
     where id = $1`,
    [id, days, `${PREFIX}-${tag}`],
  );
  return id;
}

async function alive(id) {
  const { rows } = await c.query('select 1 from auth.users where id = $1', [id]);
  return rows.length > 0;
}

async function cleanup() {
  const { rows } = await c.query(
    `select id from public.profiles where display_name like $1`,
    [`${PREFIX}-%`],
  );
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await c.query('delete from public.rooms where host_id = any($1) or winner_id = any($1)', [ids]);
    // ::text[] — auth.refresh_tokens.user_id is varchar in GoTrue, not uuid.
    await c.query('delete from auth.refresh_tokens where user_id = any($1::text[])', [ids]);
    await c.query(
      'delete from auth.flow_state where user_id = any($1) or linking_target_id = any($1)',
      [ids],
    );
    await c.query('delete from auth.users where id = any($1)', [ids]);
  }
  await c.query(`delete from public.rooms where code like 'SWP%'`);
}

// The sweep swallows its own errors by design (it runs inside create_room's transaction), so
// without this a failure is invisible and just looks like "returned -1".
c.on('notice', (n) => console.log(`  [db ${n.severity}] ${n.message}`));

await c.connect();
await cleanup();

// --- fixtures -------------------------------------------------------------
const oldClean = await mkGuest('old-clean', 40);
const oldClean2 = await mkGuest('old-clean-2', 40);
const recent = await mkGuest('recent', 1);
// Straddle the 10-day threshold to pin it down exactly.
const justUnder = await mkGuest('9-days', 9);
const justOver = await mkGuest('11-days', 11);
const withStats = await mkGuest('stats', 40);
const withAch = await mkGuest('achievement', 40);
const withSet = await mkGuest('wordset', 40);
const withPreset = await mkGuest('preset', 40);
const inRoom = await mkGuest('in-room', 40);
const isHost = await mkGuest('is-host', 40);
const isWinner = await mkGuest('is-winner', 40);
const xtina = await mkGuest('xtina', 40);
const notAnon = await mkGuest('not-anon', 40, { anonymous: false });
const linkedButAnonFlag = await mkGuest('linked-flag-lies', 40);

await c.query(`insert into public.profile_stats (profile_id, mode, games_played) values ($1,'solo',1)`, [withStats]);
await c.query(`insert into public.achievements (user_id, type) values ($1,'first_win')`, [withAch]);
const setRow = await c.query(
  `insert into public.custom_word_sets (owner_id, name) values ($1,'mine') returning id`,
  [withSet],
);
// Words hang off the set, not the profile — proving the second cascade hop (profiles ->
// custom_word_sets -> words) actually carries a guest's dictionary content away with them.
await c.query(
  `insert into public.words (word, length, custom_set_id) values ('ZZQXW', 5, $1)`,
  [setRow.rows[0].id],
);
await c.query(`insert into public.dictionary_presets (owner_id, name, config) values ($1,'p','{}'::jsonb)`, [withPreset]);
await c.query(`update public.profiles set xtina_role = 'owner' where id = $1`, [xtina]);
// is_guest is our trigger's flag; here GoTrue's is_anonymous still says true while a real
// identity exists — the sweep must refuse on the identities check alone.
await c.query(
  `insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
   values ($2::text, $1, jsonb_build_object('sub', $2::text), 'google', now(), now())`,
  [linkedButAnonFlag, String(linkedButAnonFlag)],
);

// A room hosted by isHost, with inRoom seated in it and isWinner recorded as the winner.
// Aged 40 days so the ROOM sweep would delete it — proving the guests are protected by their
// own predicates and not merely by the room still existing.
const room = await c.query(
  `insert into public.rooms (code, host_id, status, winner_id, created_at, bunch, bunch_count)
   values ('SWP01', $1, 'finished', $2, now() - interval '40 days', '{}'::jsonb, 0)
   returning id`,
  [isHost, isWinner],
);
await c.query(
  `insert into public.room_players (room_id, profile_id, display_name, seat)
   values ($1, $2, 'seated', 0)`,
  [room.rows[0].id, inRoom],
);

// Give one sweepable guest a session + refresh token, to prove the auth-side cascade.
const sess = await c.query(
  `insert into auth.sessions (id, user_id, created_at, updated_at)
   values (gen_random_uuid(), $1, now(), now()) returning id`,
  [oldClean],
);
await c.query(
  `insert into auth.refresh_tokens (token, user_id, session_id, revoked, created_at, updated_at)
   values ($1, $2, $3, false, now(), now())`,
  [`${PREFIX}-tok`, oldClean, sess.rows[0].id],
);
// flow_state rows: one keyed by user_id, one keyed ONLY by linking_target_id (what linkIdentity
// writes). Neither column has an FK, so neither is reached by the cascade.
await c.query(
  `insert into auth.flow_state (id, user_id, auth_code, code_challenge_method, code_challenge,
                                provider_type, authentication_method, created_at, updated_at)
   values (gen_random_uuid(), $1, $2, 's256', 'x', 'google', 'oauth', now(), now())`,
  [oldClean, `${PREFIX}-code-a`],
);
await c.query(
  `insert into auth.flow_state (id, user_id, linking_target_id, auth_code, code_challenge_method,
                                code_challenge, provider_type, authentication_method, created_at, updated_at)
   values (gen_random_uuid(), null, $1, $2, 's256', 'x', 'google', 'oauth', now(), now())`,
  [oldClean, `${PREFIX}-code-b`],
);

// And a NULL-session token, the orphan case the explicit delete exists for.
await c.query(
  `insert into auth.refresh_tokens (token, user_id, session_id, revoked, created_at, updated_at)
   values ($1, $2, null, false, now(), now())`,
  [`${PREFIX}-tok-orphan`, oldClean],
);

// --- test 1: p_limit is honoured ------------------------------------------
const limited = await c.query('select public._sweep_stale_guests(1) as n');
check('p_limit=1 deletes exactly one', limited.rows[0].n, 1);

// --- test 2: full sweep ---------------------------------------------------
// Sweepable set: oldClean, oldClean2, justOver, withStats, withAch, withSet, withPreset = 7.
// One already went to the p_limit=1 call above.
const swept = await c.query('select public._sweep_stale_guests() as n');
check('second sweep takes the remaining six', swept.rows[0].n, 6);

check('old clean guest #1 gone', await alive(oldClean), false);
check('old clean guest #2 gone', await alive(oldClean2), false);

check('recent guest kept', await alive(recent), true);
check('9-day-old guest kept (under the 10d threshold)', await alive(justUnder), true);
check('11-day-old guest swept (over the 10d threshold)', await alive(justOver), false);
// Stats/achievements/dictionaries are deliberately NOT protective: a guest can never sign back
// in, so those rows are already unreachable to them. The product answer is the Profile's
// "Link your account to Google to track stats" lock, not indefinite retention.
check('guest with profile_stats swept', await alive(withStats), false);
check('guest with achievement swept', await alive(withAch), false);
check('guest with custom word set swept', await alive(withSet), false);
check('guest with dictionary preset swept', await alive(withPreset), false);

const orphans = await c.query(`
  select
    (select count(*) from public.profile_stats     where profile_id = $1)::int stats,
    (select count(*) from public.achievements      where user_id    = $2)::int ach,
    (select count(*) from public.custom_word_sets  where owner_id   = $3)::int sets,
    (select count(*) from public.words             where word = 'ZZQXW')::int words,
    (select count(*) from public.dictionary_presets where owner_id  = $4)::int presets`,
  [withStats, withAch, withSet, withPreset],
);
const o = orphans.rows[0];
check('no orphaned profile_stats', o.stats, 0);
check('no orphaned achievements', o.ach, 0);
check('no orphaned custom word sets', o.sets, 0);
check('custom set WORDS cascaded away too', o.words, 0);
check('no orphaned dictionary presets', o.presets, 0);

check('guest seated in a room kept', await alive(inRoom), true);
check('guest who hosts a room kept', await alive(isHost), true);
check('guest recorded as a winner kept', await alive(isWinner), true);
check('xtina role holder kept', await alive(xtina), true);
check('non-anonymous user kept', await alive(notAnon), true);
check('anonymous-flagged user with a real identity kept', await alive(linkedButAnonFlag), true);

// --- test 3: auth-side cascade -------------------------------------------
const leftoverSess = await c.query('select count(*)::int n from auth.sessions where user_id = $1', [oldClean]);
check('sessions cascaded away', leftoverSess.rows[0].n, 0);
const leftoverTok = await c.query(`select count(*)::int n from auth.refresh_tokens where token like $1`, [`${PREFIX}-tok%`]);
check('refresh tokens gone (incl. the null-session orphan)', leftoverTok.rows[0].n, 0);
const leftoverProfile = await c.query('select count(*)::int n from public.profiles where id = $1', [oldClean]);
check('profile cascaded away', leftoverProfile.rows[0].n, 0);
const leftoverFlow = await c.query(
  `select count(*)::int n from auth.flow_state where auth_code like $1`,
  [`${PREFIX}-code-%`],
);
check('flow_state gone (both user_id and linking_target_id rows)', leftoverFlow.rows[0].n, 0);

// --- test 4: idempotent / empty ------------------------------------------
const again = await c.query('select public._sweep_stale_guests() as n');
check('re-running finds nothing', again.rows[0].n, 0);

// --- test 5: _sweep_stale_rooms drives it, and does not error on the
//             NO ACTION host/winner references it just freed -----------------
const freshVictim = await c.query(
  `insert into auth.users (id, instance_id, aud, role, is_anonymous, created_at, updated_at,
                           raw_app_meta_data, raw_user_meta_data)
   values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
           'authenticated', true, now() - interval '40 days', now(), '{}', '{}')
   returning id`,
);
const victimId = freshVictim.rows[0].id;
await c.query(
  `update public.profiles set created_at = now() - interval '40 days', display_name = $2 where id = $1`,
  [victimId, `${PREFIX}-victim`],
);
const roomsDeleted = await c.query('select public._sweep_stale_rooms() as n');
check('_sweep_stale_rooms still deletes the stale room', roomsDeleted.rows[0].n >= 1, true);
check('_sweep_stale_rooms swept the guest too', await alive(victimId), false);
// isHost/isWinner/inRoom lost their room to the room sweep that ran moments earlier in the SAME
// call, and the guest sweep runs after it — so they are collected immediately, not next cycle.
// This is the whole point of the ordering inside _sweep_stale_rooms.
check('ex-host collected in the same call', await alive(isHost), false);
check('ex-winner collected in the same call', await alive(isWinner), false);
check('ex-seated player collected in the same call', await alive(inRoom), false);
const nextPass = await c.query('select public._sweep_stale_guests() as n');
check('nothing left for the next pass', nextPass.rows[0].n, 0);

await cleanup();
await c.end();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
