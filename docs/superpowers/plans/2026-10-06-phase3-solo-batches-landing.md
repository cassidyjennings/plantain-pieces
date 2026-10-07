# Phase 3 Solo Peel Batches + Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (3.1) In solo mode a Peel draws N tiles (1–7, chosen on the solo setup screen, with a
per-Bunch-size default) instead of 1, and the last Peel takes whatever is left. Multiplayer, daily
and xtina stay exactly as they are. (3.2) Clean up the landing page: the Profile button moves inside
the right end of the display-name field, and an "or" divider separates Create Room from the
code + Join row.

**Architecture:** The batch size is stored on the room as `rooms.mode_config.peelBatch`, written once
by `create_solo_room` and read by the `peel` RPC. That RPC gets a new `mode = 'solo'` branch, and
every other mode falls through to the existing code unchanged. `peel` keeps its exact signature
(`create or replace`). `create_solo_room` needs one new argument, so it is **dropped and recreated**
with a trailing `p_peel_batch int default null`. It is not overloaded: this follows the precedent
set by `20260911000002_daily_local_date.sql`, and it means a Worker still calling with 5 named
arguments keeps working. The shared package holds the 1–7 bounds, the per-preset defaults (on
`BUNCH_SIZE_PRESETS` itself), a clamp helper and the client's peel-threshold helper. The Worker validates the value
with the shared validator, and the RPC clamps it as a final safeguard. The client's slice-fly layer
already animates any number of freshly drawn tiles, so it needs no code change. The landing page
change is JSX + CSS only.

**Tech Stack:** Supabase Postgres (plpgsql SECURITY DEFINER RPCs), Cloudflare Worker (Hono),
React 18 + TypeScript + Vite, Vitest (`packages/shared`), `pg` (Node) for local SQL smoke tests,
the Claude Browser pane for UI verification.

## Global Constraints

- Shell is Windows PowerShell / Git Bash; use npm workspaces (`npm`, never `pnpm`); use absolute paths when in doubt.
- Every game mutation goes through a `SECURITY DEFINER` RPC that row-locks the room (`select ... for update`) and is called only by the Worker with the service role.
- Redefine an existing RPC with `create or replace` and its EXACT existing signature; a signature change requires `drop function` + `create` + re-grant in the same migration (never leave two overloads; they cause "function is not unique").
- A freshly created function is executable by PUBLIC: always `revoke all ... from public, anon, authenticated` and `grant execute ... to service_role` explicitly.
- Migrations are applied in filename order; the new migration must sort after every existing file in `supabase/migrations/`.
- Local SQL verification is a scripted `pg` smoke test against `postgresql://postgres:postgres@127.0.0.1:54322/postgres` (needs `npm run db:start`, i.e. Docker Desktop running).
- Typecheck/build passing is never evidence that runtime or UI behaviour works; say plainly what was and was not verified.
- Any flex child that is an `<input>` needs `min-width: 0` alongside `flex: 1`.
- Mobile overflow is checked at 280px with a hard-width wrapper (constrain `#root`), not by trusting `resize_window` alone.
- Before reading computed styles in the Claude Browser pane, inject `*{transition:none!important}`; do not rely on `requestAnimationFrame` there (the pane pauses it).
- Any button with a visible "on" state uses `.toggle-btn`; a `:hover` rule that changes `background` also restates `color`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The new migration is NOT auto-applied to prod; it must be pasted into the Supabase dashboard SQL editor (from the file, never from chat) BEFORE the Worker change reaches `main`.

---

### Task 1: Shared peel-batch constants, defaults, clamp and threshold helpers

**Files:**
- Modify: `packages/shared/src/solo.ts` (whole file, currently 61 lines; `SoloModeConfig` at :6-9, `BunchSizePreset`/`BUNCH_SIZE_PRESETS` at :16-27, `validateSoloModeConfig` at :29-61)
- Modify: `packages/shared/test/solo.test.ts` (imports at :2-11; append new `describe` blocks at end of file)

**Interfaces:**
```ts
export interface SoloModeConfig { bunchSize: number; timed: boolean; peelBatch?: number; }
export interface BunchSizePreset { label: string; size: number; defaultPeelBatch: number; }
export const MIN_PEEL_BATCH = 1;
export const MAX_PEEL_BATCH = 7;
export function clampPeelBatch(value: unknown): number;
export function defaultPeelBatchForBunchSize(bunchSize: number): number;
export function peelThreshold(mode: string | undefined, activePlayers: number): number;
// validateSoloModeConfig gains reason 'INVALID_PEEL_BATCH'
```

- [ ] **Step 1: Write the failing tests.** In `packages/shared/test/solo.test.ts`, replace the import block at :2-11 with:

```ts
import {
  scaledBunchDistribution,
  countTiles,
  TILE_DISTRIBUTION,
  TOTAL_TILES,
  validateSoloModeConfig,
  MIN_BUNCH_SIZE,
  MAX_BUNCH_SIZE,
  BUNCH_SIZE_PRESETS,
  MIN_PEEL_BATCH,
  MAX_PEEL_BATCH,
  clampPeelBatch,
  defaultPeelBatchForBunchSize,
  peelThreshold,
} from '../src/index.js';
```

and append at the end of the file:

```ts
describe('peel batch defaults', () => {
  it('pins the per-preset defaults: Quick 2, Standard 3, Full 5', () => {
    const byLabel = Object.fromEntries(BUNCH_SIZE_PRESETS.map((p) => [p.label, p.defaultPeelBatch]));
    expect(byLabel).toEqual({ Quick: 2, Standard: 3, Full: 5 });
  });

  it('every preset default sits inside the 1-7 range', () => {
    expect(MIN_PEEL_BATCH).toBe(1);
    expect(MAX_PEEL_BATCH).toBe(7);
    for (const p of BUNCH_SIZE_PRESETS) {
      expect(p.defaultPeelBatch).toBeGreaterThanOrEqual(MIN_PEEL_BATCH);
      expect(p.defaultPeelBatch).toBeLessThanOrEqual(MAX_PEEL_BATCH);
    }
  });

  it('defaultPeelBatchForBunchSize returns the matching preset default', () => {
    for (const p of BUNCH_SIZE_PRESETS) {
      expect(defaultPeelBatchForBunchSize(p.size)).toBe(p.defaultPeelBatch);
    }
  });

  it('defaultPeelBatchForBunchSize falls back to 1 for a size no preset uses', () => {
    expect(defaultPeelBatchForBunchSize(77)).toBe(1);
  });
});

describe('clampPeelBatch (mirrors create_solo_room / peel SQL clamp)', () => {
  it('passes integers in range through unchanged', () => {
    for (let n = 1; n <= 7; n++) expect(clampPeelBatch(n)).toBe(n);
  });

  it('clamps out-of-range integers to the nearest bound', () => {
    expect(clampPeelBatch(0)).toBe(1);
    expect(clampPeelBatch(-5)).toBe(1);
    expect(clampPeelBatch(8)).toBe(7);
    expect(clampPeelBatch(99)).toBe(7);
  });

  it('truncates fractions before clamping', () => {
    expect(clampPeelBatch(3.9)).toBe(3);
  });

  it('treats missing or non-numeric input as 1 (old rooms keep old behaviour)', () => {
    expect(clampPeelBatch(undefined)).toBe(1);
    expect(clampPeelBatch(null)).toBe(1);
    expect(clampPeelBatch('4')).toBe(1);
    expect(clampPeelBatch(Number.NaN)).toBe(1);
  });
});

describe('peelThreshold', () => {
  it('solo only needs 1 tile in the Bunch, whatever the active count', () => {
    expect(peelThreshold('solo', 1)).toBe(1);
    expect(peelThreshold('solo', 3)).toBe(1);
  });

  it('every other mode needs one tile per active player', () => {
    expect(peelThreshold('multiplayer', 4)).toBe(4);
    expect(peelThreshold('daily', 1)).toBe(1);
    expect(peelThreshold('xtina', 2)).toBe(2);
    expect(peelThreshold(undefined, 2)).toBe(2);
  });
});

describe('validateSoloModeConfig peelBatch', () => {
  it('accepts a config with no peelBatch (old clients, Results rematch of an old room)', () => {
    expect(validateSoloModeConfig({ bunchSize: 54, timed: false })).toEqual({ valid: true });
  });

  it('accepts every integer from 1 to 7', () => {
    for (let n = 1; n <= 7; n++) {
      expect(validateSoloModeConfig({ bunchSize: 54, timed: false, peelBatch: n })).toEqual({ valid: true });
    }
  });

  it('rejects out-of-range, fractional and non-numeric peelBatch', () => {
    for (const bad of [0, 8, -1, 2.5, '3', null]) {
      expect(validateSoloModeConfig({ bunchSize: 54, timed: false, peelBatch: bad })).toEqual({
        valid: false,
        reason: 'INVALID_PEEL_BATCH',
      });
    }
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail.** Run `npm run test:shared`. Expected: FAIL. The new `solo.test.ts` cases fail because `MIN_PEEL_BATCH`, `clampPeelBatch`, `defaultPeelBatchForBunchSize` and `peelThreshold` are not exported (`TypeError: clampPeelBatch is not a function`) and `defaultPeelBatch` is `undefined` on every preset.

- [ ] **Step 3: Implement.** Replace `packages/shared/src/solo.ts` in full with:

```ts
/** Solo mode: a single player clears a Bunch alone, choosing its size and whether elapsed time
 * is tracked (Timed) or not (Zen). Dictionary choice reuses the existing DictionaryConfig
 * unchanged. The initial deal stays fixed (initialDealCount(1) === 21) regardless of bunchSize —
 * a smaller Bunch just means a shorter game, not a smaller opening hand. */

export interface SoloModeConfig {
  bunchSize: number;
  timed: boolean;
  /** Tiles drawn per Peel (1-7). Optional so rooms created before solo peel batches existed —
   * whose mode_config has no such key — still type-check, and so the Results rematch (which
   * passes an old room's mode_config straight back) keeps working. Absent means 1. */
  peelBatch?: number;
}

/** Below this there isn't a meaningful stretch of Peels left after the fixed 21-tile opening
 * deal. Above TOTAL_TILES (144) there are more tiles than the official set provides. */
export const MIN_BUNCH_SIZE = 40;
export const MAX_BUNCH_SIZE = 144;

/** Bounds for the solo "Tiles per peel" slider. The SQL twin is the least(7, greatest(1, ...))
 * clamp in create_solo_room and peel (migration 20261006000003) — keep them in sync. */
export const MIN_PEEL_BATCH = 1;
export const MAX_PEEL_BATCH = 7;

export interface BunchSizePreset {
  label: string;
  size: number;
  /** The "Tiles per peel" slider's starting value when this preset is picked. */
  defaultPeelBatch: number;
}

/** Quick/Standard/Full presets shown as buttons in the solo setup UI. Full uses the entire
 * official 144-tile set (scaledBunchDistribution(144) reproduces it exactly). A bigger Bunch
 * defaults to a bigger peel batch so a Full game doesn't take three times as many Peels. */
export const BUNCH_SIZE_PRESETS: BunchSizePreset[] = [
  { label: 'Quick', size: 54, defaultPeelBatch: 2 },
  { label: 'Standard', size: 99, defaultPeelBatch: 3 },
  { label: 'Full', size: 144, defaultPeelBatch: 5 },
];

/** Same rule as the SQL clamp: anything that isn't a finite number becomes 1 (the pre-batch
 * behaviour), fractions truncate, and the result is pinned to MIN_PEEL_BATCH..MAX_PEEL_BATCH. */
export function clampPeelBatch(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MIN_PEEL_BATCH;
  return Math.min(MAX_PEEL_BATCH, Math.max(MIN_PEEL_BATCH, Math.trunc(value)));
}

/** The slider default for a Bunch size: the matching preset's default, or 1 for a size no
 * preset uses (e.g. a stale value in localStorage from before the presets changed). */
export function defaultPeelBatchForBunchSize(bunchSize: number): number {
  return BUNCH_SIZE_PRESETS.find((p) => p.size === bunchSize)?.defaultPeelBatch ?? MIN_PEEL_BATCH;
}

/** How many tiles must be left in the Bunch for a Peel (rather than Plantains) to be possible.
 * Multiplayer-style modes deal 1 to every active player, so they need one per player. Solo
 * draws min(peelBatch, bunch), so a single remaining tile is still a legal (final) Peel.
 * Mirrors the gate at the top of the peel RPC. */
export function peelThreshold(mode: string | undefined, activePlayers: number): number {
  return mode === 'solo' ? 1 : activePlayers;
}

export type SoloModeConfigValidity =
  | { valid: true }
  | { valid: false; reason: 'INVALID_BUNCH_SIZE' | 'INVALID_TIMED_FLAG' | 'INVALID_PEEL_BATCH' };

/** Validates a candidate SoloModeConfig. Reused by the client (instant feedback) and the Worker
 * (defense-in-depth before calling create_solo_room, which re-validates authoritatively). */
export function validateSoloModeConfig(config: unknown): SoloModeConfigValidity {
  if (typeof config !== 'object' || config === null) {
    return { valid: false, reason: 'INVALID_BUNCH_SIZE' };
  }
  const c = config as Record<string, unknown>;
  const { bunchSize, timed, peelBatch } = c;
  if (
    typeof bunchSize !== 'number' ||
    !Number.isInteger(bunchSize) ||
    bunchSize < MIN_BUNCH_SIZE ||
    bunchSize > MAX_BUNCH_SIZE
  ) {
    return { valid: false, reason: 'INVALID_BUNCH_SIZE' };
  }
  if (typeof timed !== 'boolean') {
    return { valid: false, reason: 'INVALID_TIMED_FLAG' };
  }
  if (
    peelBatch !== undefined &&
    (typeof peelBatch !== 'number' ||
      !Number.isInteger(peelBatch) ||
      peelBatch < MIN_PEEL_BATCH ||
      peelBatch > MAX_PEEL_BATCH)
  ) {
    return { valid: false, reason: 'INVALID_PEEL_BATCH' };
  }
  return { valid: true };
}
```

- [ ] **Step 4: Run the tests and confirm they pass.** Run `npm run test:shared`. Expected: PASS, all files green, including the 4 new `describe` blocks in `solo.test.ts`. Then run `npm run typecheck --workspace @plantain/web` and `npm run typecheck --workspace @plantain/api`. Expected: both exit 0 (`Profile.tsx` only reads `preset.label`/`preset.size`, so the new required field breaks nothing).

- [ ] **Step 5: Commit.**

```bash
git add packages/shared/src/solo.ts packages/shared/test/solo.test.ts
git commit -m "feat(shared): solo peel-batch bounds, preset defaults, clamp and threshold helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Migration — `create_solo_room` stores `peelBatch`, `peel` draws a batch in solo

**Files:**
- Create: `scripts/smoke-solo-batch.mjs`
- Create: `supabase/migrations/20261006000003_solo_peel_batch.sql` (the latest existing file is `20260924000004_daily_result_summary_rpc.sql`. Before you create this file, run `ls supabase/migrations | tail -5`. If Phase 1/2/4 work has already added a `20261006*` file numbered `000003` or higher, bump this file's suffix so it sorts last, and update the filename everywhere in this plan.)
- Reference (copied from, not modified): `supabase/migrations/20260818000001_rack_version.sql:21-117` (latest `peel`; nothing after it redefines `peel`. Checked with `grep -n "create or replace function public.peel" supabase/migrations/*`), `supabase/migrations/20260728000006_stats_scale_with_users.sql:486-559` (latest `create_solo_room`), `supabase/migrations/20260911000002_daily_local_date.sql:9-14,113-114` (drop-and-recreate precedent + grants).

**Interfaces:**
```sql
public.create_solo_room(p_host uuid, p_display_name text, p_dictionary_config jsonb,
                        p_bunch_size int, p_timed boolean, p_peel_batch int default null) returns jsonb
  -- mode_config = {bunchSize, timed, peelBatch}; return adds 'peelBatch'
public.peel(p_room_id uuid, p_profile uuid, p_expected_count int) returns jsonb   -- signature unchanged
  -- 'peel' room_event payload gains 'drawn' (tiles the caller just received)
```

- [ ] **Step 1: Write the failing smoke test.** Create `scripts/smoke-solo-batch.mjs`:

```js
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
const freshUser = () => makeUser(`solo-batch-${Date.now()}-${userSeq++}@example.test`);

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

  await client.end();
  console.log('\nall smoke checks passed');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
```

- [ ] **Step 2: Run it and watch it fail.** Make sure the local stack is up (`npm run db:start`), then run `node scripts/smoke-solo-batch.mjs`. Expected: it prints `ok  exactly one create_solo_room ...` and `ok  exactly one peel ...`, then exits 1 with `FAIL: create_solo_room takes p_peel_batch`, because the function still has its old 5-argument signature.

- [ ] **Step 3: Write the migration.** Create `supabase/migrations/20261006000003_solo_peel_batch.sql`:

```sql
-- Solo peel batches: in solo, a Peel draws N tiles (1-7, chosen at setup) instead of 1.
--
-- Storage: rooms.mode_config.peelBatch, camelCase like the bunchSize/timed keys already beside it
-- (and so Results' rematch, which passes an old room's mode_config straight back as a
-- SoloModeConfig, round-trips it). Absent on every room created before this migration -> 1.
--
-- create_solo_room needs a new argument, so it is DROPPED and recreated rather than overloaded:
-- a 5-argument call would be ambiguous between a 5-arg function and a 6-arg one with a default
-- (same reasoning as 20260911000002_daily_local_date). The default also lets the Worker that is
-- still deployed when this runs keep calling with five named arguments. A recreated function
-- loses its grants, so they are restated at the bottom.
--
-- peel keeps its exact signature (create or replace). Only a new mode = 'solo' branch is added,
-- and every other mode runs the same code as before. The solo gate is bunch_count >= 1. That is
-- already what the old gate computed for a single player, but it is now explicit, so a solo
-- room's "can peel" no longer depends on its player count. The peel event also gains 'drawn'
-- (tiles the caller just received), computed as a tile_count delta so it is right for every
-- mode.

drop function if exists public.create_solo_room(uuid, text, jsonb, int, boolean);

create or replace function public.create_solo_room(
  p_host uuid, p_display_name text, p_dictionary_config jsonb, p_bunch_size int, p_timed boolean,
  p_peel_batch int default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_room_id uuid;
  v_config jsonb;
  v_bunch jsonb;
  v_deal int;
  v_tiles text[];
  v_peel_batch int;
begin
  perform public._sweep_stale_rooms();

  if p_bunch_size < 40 or p_bunch_size > 144 then
    raise exception 'INVALID_BUNCH_SIZE' using errcode = 'P0001';
  end if;

  -- Clamped, not rejected: the Worker already 400s an out-of-range value (shared
  -- validateSoloModeConfig); this is the last line of defence. Twin of clampPeelBatch in
  -- packages/shared/src/solo.ts.
  v_peel_batch := least(7, greatest(1, coalesce(p_peel_batch, 1)));

  v_config := coalesce(p_dictionary_config,
    '{"minLength":2,"maxLength":null,"baseEnabled":true,"excludedTopics":[],"customSetIds":[]}'::jsonb);
  v_bunch := public._scaled_bunch(p_bunch_size);

  loop
    v_code := (
      select string_agg(
        substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789',
               (floor(random() * length('ABCDEFGHJKMNPQRSTUVWXYZ23456789')) + 1)::int, 1),
        '')
      from generate_series(1, 6)
    );
    exit when not exists (select 1 from public.rooms where code = v_code);
  end loop;

  insert into public.rooms (
    code, host_id, dictionary_config, bunch, bunch_count,
    mode, mode_config, status, started_at
  ) values (
    v_code, p_host, v_config, v_bunch, p_bunch_size,
    'solo', jsonb_build_object('bunchSize', p_bunch_size, 'timed', p_timed, 'peelBatch', v_peel_batch),
    'active', now()
  ) returning id into v_room_id;

  insert into public.room_players (room_id, profile_id, display_name, seat)
  values (v_room_id, p_host, p_display_name, 0);

  insert into public.room_events (room_id, type, payload)
  values (v_room_id, 'player_joined',
          jsonb_build_object('profileId', p_host, 'displayName', p_display_name, 'seat', 0));

  v_deal := public._initial_deal(1);
  v_tiles := public._draw_from_bunch(v_room_id, v_deal);
  update public.room_players
    set rack = to_jsonb(v_tiles), tile_count = array_length(v_tiles, 1), grid_state = '{}'::jsonb
    where room_id = v_room_id and profile_id = p_host;

  insert into public.room_events (room_id, type, payload)
  values (v_room_id, 'game_started',
          jsonb_build_object('dealt', v_deal,
                             'bunchCount', (select bunch_count from public.rooms where id = v_room_id),
                             'tileCounts', public._tile_counts(v_room_id)));

  return jsonb_build_object('roomId', v_room_id, 'code', v_code, 'seat', 0,
                            'bunchSize', p_bunch_size, 'timed', p_timed, 'peelBatch', v_peel_batch);
end;
$$;

-- ---------------------------------------------------------------------------
-- peel — same body as 20260818000001_rack_version, + solo batch branch, + explicit solo gate,
-- + 'drawn' in the event payload.
-- ---------------------------------------------------------------------------
create or replace function public.peel(p_room_id uuid, p_profile uuid, p_expected_count int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_active int;
  v_caller public.room_players;
  v_player record;
  v_tiles text[];
  v_new_rack jsonb;
  v_new_rack_version int;
  v_new_tile_count int;
  v_partner uuid;
  v_step int;
  v_batch int;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_room.status <> 'active' then raise exception 'GAME_NOT_ACTIVE' using errcode = 'P0001'; end if;

  select * into v_caller from public.room_players
    where room_id = p_room_id and profile_id = p_profile and not is_spectator;
  if not found then raise exception 'NOT_A_PLAYER' using errcode = 'P0001'; end if;
  if v_caller.tile_count <> p_expected_count then
    raise exception 'STALE_ACTION' using errcode = 'P0001';
  end if;

  select count(*) into v_active
    from public.room_players where room_id = p_room_id and not is_spectator;

  -- Solo draws least(peelBatch, bunch_count), so a single remaining tile is still a legal final
  -- Peel. Every other mode deals 1 to each active player and needs one tile per player.
  -- Client twin: peelThreshold() in packages/shared/src/solo.ts.
  if v_room.bunch_count < (case when v_room.mode = 'solo' then 1 else v_active end) then
    raise exception 'BUNCH_TOO_LOW' using errcode = 'P0001';
  end if;

  if v_room.mode = 'xtina' then
    v_partner := (v_room.mode_config ->> 'partnerId')::uuid;
    v_step := (v_room.mode_config ->> 'step')::int + 1;
    if v_step > 10 then
      raise exception 'XTINA_SCRIPT_EXHAUSTED' using errcode = 'P0001';
    end if;

    -- Partner: the next word's letters.
    v_tiles := public._xtina_step_letters(v_step);
    perform public._xtina_take(p_room_id, v_tiles);
    update public.room_players rp
      set rack = rp.rack || to_jsonb(v_tiles),
          tile_count = rp.tile_count + coalesce(array_length(v_tiles, 1), 0),
          rack_version = rp.rack_version + 1
      where rp.room_id = p_room_id and rp.profile_id = v_partner;

    -- Owner: one more junk tile. Index 5 was the last dealt at Split, so step 2 draws index 6.
    v_tiles := array[public._xtina_owner_tile(4 + v_step)];
    perform public._xtina_take(p_room_id, v_tiles);
    update public.room_players rp
      set rack = rp.rack || to_jsonb(v_tiles),
          tile_count = rp.tile_count + 1,
          rack_version = rp.rack_version + 1
      where rp.room_id = p_room_id and rp.profile_id = v_room.host_id;

    update public.rooms
      set mode_config = jsonb_set(mode_config, '{step}', to_jsonb(v_step))
      where id = p_room_id;
  elsif v_room.mode = 'solo' then
    -- Rooms created before 20261006000003 have no peelBatch key -> 1, i.e. the old behaviour.
    -- Same clamp as create_solo_room, so a hand-edited mode_config can't over- or under-draw.
    v_batch := least(7, greatest(1, coalesce((v_room.mode_config ->> 'peelBatch')::int, 1)));
    -- The last Peel takes the remainder: fewer than v_batch left -> draw them all.
    v_tiles := public._draw_from_bunch(p_room_id, least(v_batch, v_room.bunch_count));
    update public.room_players rp
      set rack = rp.rack || to_jsonb(v_tiles),
          tile_count = rp.tile_count + coalesce(array_length(v_tiles, 1), 0),
          rack_version = rp.rack_version + 1
      where rp.room_id = p_room_id and rp.profile_id = p_profile;
  else
    for v_player in
      select profile_id from public.room_players
      where room_id = p_room_id and not is_spectator order by seat
    loop
      v_tiles := public._draw_from_bunch(p_room_id, 1);
      update public.room_players rp
        set rack = rp.rack || to_jsonb(v_tiles),
            tile_count = rp.tile_count + coalesce(array_length(v_tiles, 1), 0),
            rack_version = rp.rack_version + 1
        where rp.room_id = p_room_id and rp.profile_id = v_player.profile_id;
    end loop;
  end if;

  select rack, rack_version, tile_count into v_new_rack, v_new_rack_version, v_new_tile_count
    from public.room_players
    where room_id = p_room_id and profile_id = p_profile;

  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'peel',
          jsonb_build_object('actor', p_profile,
                             'drawn', v_new_tile_count - v_caller.tile_count,
                             'bunchCount', (select bunch_count from public.rooms where id = p_room_id),
                             'tileCounts', public._tile_counts(p_room_id)));

  return jsonb_build_object('ok', true, 'rack', v_new_rack, 'rackVersion', v_new_rack_version,
                            'bunchCount', (select bunch_count from public.rooms where id = p_room_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. peel kept its signature, so create or replace kept its grants. create_solo_room was
-- recreated, and a new function is executable by PUBLIC until revoked.
-- ---------------------------------------------------------------------------
do $$
begin
  execute 'revoke all on function public.create_solo_room(uuid,text,jsonb,int,boolean,int) from public, anon, authenticated';
  execute 'grant execute on function public.create_solo_room(uuid,text,jsonb,int,boolean,int) to service_role';
end $$;
```

- [ ] **Step 4: Apply the migration locally.** Run (Git Bash, repo root):

```bash
node -e "const pg=require('pg');const fs=require('fs');const c=new pg.Client('postgresql://postgres:postgres@127.0.0.1:54322/postgres');c.connect().then(()=>c.query(fs.readFileSync(process.argv[1],'utf8'))).then(()=>{console.log('applied');return c.end()}).catch(e=>{console.error(e.message);process.exit(1)})" supabase/migrations/20261006000003_solo_peel_batch.sql
```

Expected: `applied`. (This runs the file exactly as the prod dashboard paste will. `npm run db:reset` also works, but it wipes local data, including any seeded dictionaries.)

- [ ] **Step 5: Run the smoke test and confirm it passes.** Run `node scripts/smoke-solo-batch.mjs`. Expected: every line `ok  ...`, ending `all smoke checks passed`, exit 0. Then rerun the xtina smoke test to make sure the copied xtina branch is intact: `node scripts/smoke-xtina.mjs`. Expected: `all smoke checks passed`.

- [ ] **Step 6: Commit.**

```bash
git add supabase/migrations/20261006000003_solo_peel_batch.sql scripts/smoke-solo-batch.mjs
git commit -m "feat(db): solo peel batches - create_solo_room stores peelBatch, peel draws a batch in solo

create_solo_room is dropped and recreated with a trailing p_peel_batch default null (no
overload; old 5-arg Worker calls still resolve). peel keeps its signature and only gains a
mode = 'solo' branch, an explicit solo gate (bunch >= 1) and 'drawn' in the event payload.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Worker — forward `peelBatch` and map `INVALID_PEEL_BATCH`

**Files:**
- Modify: `apps/api/src/index.ts:105-126` (`app.post('/rooms/solo', ...)`)
- Modify: `apps/api/src/rpcError.ts:39-41` (Solo mode block of `KNOWN_ERRORS`)

**Interfaces:**
```ts
// POST /rooms/solo body: { displayName: string; dictionaryConfig?: DictionaryConfig; modeConfig: SoloModeConfig }
// modeConfig.peelBatch?: integer 1-7 -> 400 { error: 'INVALID_PEEL_BATCH' } otherwise
admin.rpc('create_solo_room', { ..., p_peel_batch: number | null })
```

- [ ] **Step 1: Confirm the existing validator already covers the failing case.** The Worker calls `validateSoloModeConfig` unchanged at `apps/api/src/index.ts:113`, so the `INVALID_PEEL_BATCH` rejection is already exercised by Task 1's `validateSoloModeConfig peelBatch` tests. Run `npm run test:shared`. Expected: PASS. (There is no Worker test harness in this repo, so the HTTP-level check is Task 4, Step 6.)

- [ ] **Step 2: Implement the RPC argument.** In `apps/api/src/index.ts`, replace the `admin.rpc('create_solo_room', {...})` call at :117-123 with:

```ts
  const { data, error } = await admin.rpc('create_solo_room', {
    p_host: profileId,
    p_display_name: body.displayName,
    p_dictionary_config: body.dictionaryConfig ?? null,
    p_bunch_size: body.modeConfig.bunchSize,
    p_timed: body.modeConfig.timed,
    // Optional: absent (an old client, or a Results rematch of a pre-batch room) -> null -> the
    // RPC defaults it to 1. Range was already checked by validateSoloModeConfig above.
    p_peel_batch: body.modeConfig.peelBatch ?? null,
  });
```

- [ ] **Step 3: Map the new error code.** In `apps/api/src/rpcError.ts`, replace the solo block at :39-41 with:

```ts
  // Solo mode
  INVALID_BUNCH_SIZE: 400,
  INVALID_TIMED_FLAG: 400,
  INVALID_PEEL_BATCH: 400,
```

- [ ] **Step 4: Typecheck.** Run `npm run typecheck --workspace @plantain/api`. Expected: exit 0. (This only proves the code compiles. The behaviour is verified over real HTTP in Task 4, Step 6.)

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/index.ts apps/api/src/rpcError.ts
git commit -m "feat(api): forward solo peelBatch to create_solo_room, map INVALID_PEEL_BATCH to 400

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Solo setup "Tiles per peel" slider

**Files:**
- Modify: `apps/web/src/pages/SoloSetup.tsx` (import at :3, state at :32-43, `handleStart` at :61-72, Bunch size section at :105-120). The spec calls this file `SoloSetupModal.tsx`, but the setup is now a full page, `SoloSetup.tsx`.
- Modify: `apps/web/src/styles.css` (insert after the `.choice-tile .s` rule, currently around :3976-3981, before `/* The lobby's label-over-control triple ... */`)

**Interfaces:**
```ts
const [peelBatch, setPeelBatch] = useState<number>(() => defaultPeelBatchForBunchSize(bunchSize));
api.createSoloRoom(name, dictConfig, { bunchSize, timed, peelBatch });
// DOM: <input id="peel-batch" type="range" min=1 max=7 step=1>, <output class="peel-batch-value">
```

- [ ] **Step 1: Write the failing browser check (run it first, before the change).** Start the stack with `preview_start` name `api`, then `preview_start` name `web`, and navigate the pane to `http://localhost:<web port>/solo`. Run this with `javascript_tool`:

```js
(async () => {
  document.head.insertAdjacentHTML('beforeend', '<style>*{transition:none!important}</style>');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const slider = document.querySelector('#peel-batch');
  if (!slider) return { pass: false, reason: 'no #peel-batch slider' };
  const bunchTiles = [...document.querySelectorAll('.solo-section')]
    .find((s) => s.textContent.includes('Bunch size')).querySelectorAll('.choice-tile');
  const setRange = (v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, String(v));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const out = { min: slider.min, max: slider.max, step: slider.step };
  bunchTiles[0].click(); await wait(50); out.quick = slider.value;
  bunchTiles[1].click(); await wait(50); out.standard = slider.value;
  bunchTiles[2].click(); await wait(50); out.full = slider.value;
  setRange(7); await wait(50); out.movedTo7 = slider.value;
  out.outputShows = document.querySelector('.peel-batch-value')?.textContent;
  bunchTiles[1].click(); await wait(50); out.resetOnPresetChange = slider.value;
  out.pass = out.min === '1' && out.max === '7' && out.step === '1' && out.quick === '2' &&
    out.standard === '3' && out.full === '5' && out.movedTo7 === '7' && out.outputShows === '7' &&
    out.resetOnPresetChange === '3';
  return out;
})()
```

Expected before the change: `{ pass: false, reason: 'no #peel-batch slider' }`.

- [ ] **Step 2: Implement the slider.** In `apps/web/src/pages/SoloSetup.tsx`:

Replace the import at :3 with:

```ts
import {
  DEFAULT_DICTIONARY_CONFIG,
  BUNCH_SIZE_PRESETS,
  WORD_LENGTH_MAX,
  MIN_PEEL_BATCH,
  MAX_PEEL_BATCH,
  clampPeelBatch,
  defaultPeelBatchForBunchSize,
  type DictionaryConfig,
} from '@plantain/shared';
```

Insert directly after `const setTimed = useSettingsStore((s) => s.setSoloTimed);` (:35):

```ts
  // Tiles per peel. Deliberately local state, not persisted: it starts at the current Bunch
  // size's default and resets to the new preset's default whenever the preset changes (spec
  // 3.1), so a remembered value would just be overwritten on the first preset click anyway.
  const [peelBatch, setPeelBatch] = useState<number>(() => defaultPeelBatchForBunchSize(bunchSize));
```

In `handleStart`, replace

```ts
      const room = await api.createSoloRoom(name, dictConfig, { bunchSize, timed });
```

with

```ts
      const room = await api.createSoloRoom(name, dictConfig, { bunchSize, timed, peelBatch });
```

Replace the whole Bunch size section (:105-120) with:

```tsx
        <div className="solo-section">
          <span className="solo-section-label">Bunch size</span>
          <div className="tile-row">
            {BUNCH_SIZE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={`choice-tile toggle-btn${bunchSize === preset.size ? ' selected' : ''}`}
                onClick={() => {
                  setBunchSize(preset.size);
                  setPeelBatch(preset.defaultPeelBatch);
                }}
              >
                <span className="t">{preset.label}</span>
                <span className="s">{preset.size} tiles</span>
              </button>
            ))}
          </div>
        </div>

        <div className="solo-section">
          <label className="solo-section-label" htmlFor="peel-batch">
            Tiles per peel
          </label>
          <div className="peel-batch-row">
            <input
              id="peel-batch"
              type="range"
              className="peel-batch-slider"
              min={MIN_PEEL_BATCH}
              max={MAX_PEEL_BATCH}
              step={1}
              value={peelBatch}
              onChange={(e) => setPeelBatch(clampPeelBatch(Number(e.target.value)))}
              aria-valuetext={`${peelBatch} ${peelBatch === 1 ? 'tile' : 'tiles'} per peel`}
            />
            <output className="peel-batch-value" htmlFor="peel-batch">
              {peelBatch}
            </output>
          </div>
        </div>
```

In `apps/web/src/styles.css`, insert after the `.choice-tile .s { ... }` rule:

```css
/* Solo "Tiles per peel" slider. The global `input` rule styles every input as a padded,
   bordered text field; none of that suits a range control, so it is reset here. flex: 1 needs
   min-width: 0 or the range's intrinsic width can push the value readout out of the panel on a
   narrow phone (same flexbox trap as .join-row input). */
.peel-batch-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.peel-batch-slider {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  accent-color: var(--color-accent);
  cursor: pointer;
}
.peel-batch-value {
  flex: none;
  min-width: 2ch;
  text-align: right;
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 20px;
  color: var(--color-text-primary);
}
```

- [ ] **Step 3: Typecheck.** Run `npm run typecheck --workspace @plantain/web`. Expected: exit 0.

- [ ] **Step 4: Re-run the browser check from Step 1.** Reload `/solo` in the pane and run the same snippet. Expected: `pass: true`, with `quick: '2'`, `standard: '3'`, `full: '5'`, `movedTo7: '7'`, `outputShows: '7'`, `resetOnPresetChange: '3'`. Take a screenshot of the panel showing the slider under "Bunch size".

- [ ] **Step 5: Check that a real Split stores the chosen batch.** In the pane on `/solo`: click "Quick", set the slider to 6 (use the `setRange(6)` line from Step 1), click **Split!**, and wait until the URL contains `/game`. Then run from the repo root:

```bash
node -e "const pg=require('pg');const c=new pg.Client('postgresql://postgres:postgres@127.0.0.1:54322/postgres');c.connect().then(()=>c.query(\"select mode, mode_config, bunch_count from public.rooms where mode='solo' order by created_at desc limit 1\")).then(r=>{console.log(JSON.stringify(r.rows[0]));return c.end()})"
```

Expected: `{"mode":"solo","mode_config":{"bunchSize":54,"timed":false,"peelBatch":6},"bunch_count":33}` (`timed` follows whatever Pace is selected).

- [ ] **Step 6: Check the Worker's 400 over real HTTP.** In the pane (any page of the app, since the session is already signed in), run with `javascript_tool`, substituting the API port that `preview_logs` reports for the `api` server if it isn't 8787:

```js
(async () => {
  const API = 'http://127.0.0.1:8787';
  const key = Object.keys(sessionStorage).find((k) => k.endsWith('-auth-token'));
  const token = JSON.parse(sessionStorage.getItem(key)).access_token;
  const post = (modeConfig) => fetch(`${API}/rooms/solo`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'BatchCheck', modeConfig }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return {
    tooHigh: await post({ bunchSize: 54, timed: false, peelBatch: 9 }),
    fractional: await post({ bunchSize: 54, timed: false, peelBatch: 2.5 }),
    absent: await post({ bunchSize: 54, timed: false }),
  };
})()
```

Expected: `tooHigh` and `fractional` are `{ status: 400, body: { error: 'INVALID_PEEL_BATCH' } }`. `absent` is status 200 with a `roomId` and `peelBatch: 1` in the body.

- [ ] **Step 7: Check for overflow at 280px.** Navigate to `/solo`, run `resize_window` with preset `mobile` (so the `<480px` media rules apply), then run:

```js
(() => {
  document.head.insertAdjacentHTML('beforeend', '<style>*{transition:none!important}</style>');
  const root = document.getElementById('root');
  root.style.width = '280px';
  root.style.overflowX = 'auto';
  const edge = root.getBoundingClientRect().right;
  const offenders = [...root.querySelectorAll('*')]
    .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > edge + 0.5)
    .map((el) => `${el.tagName}.${el.className}`);
  const slider = document.querySelector('#peel-batch').getBoundingClientRect();
  const value = document.querySelector('.peel-batch-value').getBoundingClientRect();
  return {
    overflowing: root.scrollWidth > root.clientWidth,
    offenders: offenders.slice(0, 10),
    valueRightOfSlider: value.left >= slider.right,
    valueInside: value.right <= edge,
  };
})()
```

Expected: `overflowing: false`, `offenders: []`, `valueRightOfSlider: true`, `valueInside: true`. Then reset with `resize_window` preset `desktop` and reload the page.

- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/pages/SoloSetup.tsx apps/web/src/styles.css
git commit -m "feat(solo): Tiles per peel slider (1-7) with per-preset defaults

Quick 2 / Standard 3 / Full 5; picking a preset resets the slider to its default.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Client peel gate uses `peelThreshold`; slice-fly documented for N-tile peels

**Files:**
- Modify: `apps/web/src/pages/Game.tsx`: shared import (:3-15), refs (:290-310, `bunchRef` at :296/:306), slice-fly comment (:332-334), `runAutoAction` (:1389-1393). Line numbers are as of commit `040c119`. If Phase 1/2 edits have already landed, find each spot by the quoted code instead.

**Interfaces:**
```ts
const roomModeRef = useRef<PublicRoom['mode'] | undefined>(undefined);
const canPeel = bunchRef.current >= peelThreshold(roomModeRef.current, activeCount);
```

- [ ] **Step 1: Confirm the helper's failing-then-passing tests exist.** `peelThreshold` is covered by Task 1's `describe('peelThreshold')`. Run `npm run test:shared`. Expected: PASS. (The `Game.tsx` wiring itself has no unit harness. Its runtime check is Step 5.)

- [ ] **Step 2: Wire the gate.** In `apps/web/src/pages/Game.tsx`:

Add `peelThreshold,` to the `@plantain/shared` import, directly after `GRID_SIZE,`.

Replace

```ts
  const bunchRef = useRef(bunchCount);
```

with

```ts
  const bunchRef = useRef(bunchCount);
  // runAutoAction is a stable useCallback and reads live values through refs; the room's mode
  // decides the peel threshold (solo: 1 tile left is enough, see peelThreshold).
  const roomModeRef = useRef<PublicRoom['mode'] | undefined>(undefined);
```

Replace

```ts
  bunchRef.current = bunchCount;
```

with

```ts
  bunchRef.current = bunchCount;
  roomModeRef.current = room?.mode;
```

In `runAutoAction`, replace

```ts
    const canPeel = bunchRef.current >= activeCount;
```

with

```ts
    // Solo peels draw min(peelBatch, bunch), so even 1 tile left is a Peel, not Plantains.
    // Every other mode deals 1 per active player. Mirrors the gate in the peel RPC.
    const canPeel = bunchRef.current >= peelThreshold(roomModeRef.current, activeCount);
```

- [ ] **Step 3: Update the slice-fly comment so it doesn't go stale.** Replace the line

```ts
  // this correctly ignores those. Peel adds 1 tile → 1 slice; Dump adds 3 → 3 staggered slices.
```

with

```ts
  // this correctly ignores those. Peel adds 1 tile → 1 slice (a solo peel batch adds up to 7 →
  // up to 7 staggered slices, queued in SLICE_WAVE-sized waves); Dump adds 3 → 3 staggered slices.
```

No logic change: the effect already launches one slice per fresh `justDrawn` tile, tightens the stagger to 70ms once a burst exceeds `SLICE_WAVE` (4), and sizes the reveal fallback to the number of waves. That path was built for xtina's 10-tile deals. `applyServerRack` marks every tile in `diffNewLetters(prior, newRack)` as just drawn, so a 7-tile peel response yields 7 fresh tiles.

- [ ] **Step 4: Typecheck.** Run `npm run typecheck --workspace @plantain/web`. Expected: exit 0.

- [ ] **Step 5: Runtime check of a batch peel in the browser (logic-level plus one real UI path).** Note for the report: for a 1-player solo room, `activeCount` is always 1, so the old and new gates give the same answer. This change makes the intent explicit rather than fixing a reachable bug, and Task 2's smoke test is the authoritative check of the server gate. To watch an N-tile draw animate:
  1. Start a Quick solo game with the slider at 7 (Task 4, Step 5 flow) and note the room id from the URL.
  2. Build any valid connected grid using all 21 tiles and let auto-Peel fire. If an agent can't reasonably solve the board, skip to 4.
  3. Expected: one `PEEL!` callout, 7 slices fly into the tray, tray count goes 0 → 7, and the Bunch meter drops by 7 (33 → 26).
  4. If step 2 was skipped, record "N-slice animation on a real solo peel: NOT verified live; needs a manual playtest". Do not claim it was verified.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/pages/Game.tsx
git commit -m "feat(game): solo peel gate via shared peelThreshold (1 tile left is still a Peel)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Landing page — Profile button inside the name field, "or" divider

**Files:**
- Modify: `apps/web/src/pages/Home.tsx:74-137` (the `.panel` block and `.home-links` block of the returned JSX)
- Modify: `apps/web/src/styles.css`: flat-press selector list at :127-133 (the `.home-profile-btn:active:not(:disabled),` entry at :130), `.join-row` block at :217-225 (insert the new rules after it), `.home-profile-btn` + its hover rule at :3289-3305 (delete)

**Interfaces:**
```tsx
<div className="field">
  <label htmlFor="home-display-name">Display name</label>
  <div className="name-field">
    <input id="home-display-name" className="name-field-input" ... />
    <button type="button" className="home-profile-inline" aria-label="My Profile">…</button>
  </div>
</div>
<div className="or-divider"><span>or</span></div>
```

- [ ] **Step 1: Write the failing browser check (run it before the change).** With `api` + `web` running (Task 4, Step 1), navigate the pane to `http://localhost:<web port>/` and run:

```js
(() => {
  document.head.insertAdjacentHTML('beforeend', '<style>*{transition:none!important}</style>');
  const input = document.querySelector('#home-display-name');
  const btn = document.querySelector('.home-profile-inline');
  if (!input || !btn) return { pass: false, reason: 'no #home-display-name / .home-profile-inline' };
  const original = input.value;
  const setVal = (v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setVal('WWWWWWWWWWWWWWWWWWWWWWWW');
  input.blur();
  const cs = getComputedStyle(input);
  const ir = input.getBoundingClientRect();
  const br = btn.getBoundingClientRect();
  const padR = parseFloat(cs.paddingRight);
  const out = {
    textOverflow: cs.textOverflow,
    whiteSpace: cs.whiteSpace,
    overflowX: cs.overflowX,
    longNameOverflows: input.scrollWidth > input.clientWidth,
    paddingRight: padR,
    buttonWidth: Math.round(br.width),
    paddingClearsButton: padR >= ir.right - br.left,
    buttonInsideInput: br.left >= ir.left && br.right <= ir.right && br.top >= ir.top && br.bottom <= ir.bottom,
    buttonText: btn.textContent.trim(),
    hasAvatar: !!btn.querySelector('svg'),
    oldProfileBtnGone: !document.querySelector('.home-profile-btn'),
    dictionaryStillInLinks: !!document.querySelector('.home-links .dictionary-open-btn'),
    labelTargetsInput: document.querySelector('label[for="home-display-name"]')?.control === input,
    divider: (() => {
      const d = document.querySelector('.panel .or-divider');
      if (!d) return null;
      const create = [...document.querySelectorAll('.panel > button')].find((b) => b.textContent.includes('Create Room'));
      const join = document.querySelector('.panel .join-row');
      return {
        text: d.textContent.trim(),
        between: create.getBoundingClientRect().bottom <= d.getBoundingClientRect().top &&
          d.getBoundingClientRect().bottom <= join.getBoundingClientRect().top,
      };
    })(),
  };
  setVal(original);
  out.pass = out.textOverflow === 'ellipsis' && out.whiteSpace === 'nowrap' && out.longNameOverflows &&
    out.paddingClearsButton && out.buttonInsideInput && out.buttonText === 'Profile' && out.hasAvatar &&
    out.oldProfileBtnGone && out.dictionaryStillInLinks && out.labelTargetsInput &&
    out.divider?.text === 'or' && out.divider?.between === true;
  return out;
})()
```

Expected before the change: `{ pass: false, reason: 'no #home-display-name / .home-profile-inline' }`. (The snippet restores the original name, so the guest-only `plantain-display-name` cache is left as it was.)

- [ ] **Step 2: Implement the JSX.** In `apps/web/src/pages/Home.tsx`, replace everything from `      <div className="panel">` (:74) through the closing `</div>` of `.home-links` (:137) with:

```tsx
      <div className="panel">
        {/* A div, not the old wrapping <label>: the Profile button now sits inside the field, and
            interactive content nested in a <label> is invalid and muddies what a click activates. */}
        <div className="field">
          <label htmlFor="home-display-name">Display name</label>
          <div className="name-field">
            <input
              id="home-display-name"
              className="name-field-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Guest"
              maxLength={24}
            />
            <button
              type="button"
              className="home-profile-inline"
              onClick={() => navigate('/profile')}
              aria-label="My Profile"
            >
              <Avatar config={avatarConfig} size={22} />
              <span>Profile</span>
            </button>
          </div>
        </div>

        <button disabled={busy} onClick={handleCreate}>
          Create Room
        </button>

        <div className="or-divider">
          <span>or</span>
        </div>

        <div className="join-row">
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="Room code"
            maxLength={6}
          />
          <button className="btn-secondary" disabled={busy || !joinCode.trim()} onClick={handleJoin}>
            Join
          </button>
        </div>

        {error && <p className="error">{error}</p>}
      </div>

      <div className="home-modes">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            persistName();
            const solvedRoom = solvedTodayRoomId();
            navigate(solvedRoom ? `/room/${solvedRoom}/results` : '/daily');
          }}
        >
          Daily Puzzle
          {streak > 0 && <span className="home-mode-streak">🔥{streak}</span>}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            persistName();
            navigate('/solo');
          }}
        >
          Play Solo
        </button>
      </div>

      <div className="home-links">
        <button type="button" className="dictionary-open-btn" onClick={() => setShowJournal(true)}>
          My Dictionaries
        </button>
      </div>
```

(The streak span is copied unchanged from the current file. Phase 1/2 may change it; if they already have, keep their version.)

- [ ] **Step 3: Implement the CSS.** In `apps/web/src/styles.css`:

(a) In the flat-press selector list at :127-133, replace the line

```css
.home-profile-btn:active:not(:disabled),
```

with

```css
.home-profile-inline:active:not(:disabled),
```

(b) Delete the `.home-profile-btn { ... }` rule and the `.home-profile-btn:hover:not(:disabled) { ... }` rule (:3289-3305). Leave `.home-links` alone.

(c) Insert directly after the `.join-row input { flex: 1; min-width: 0; }` rule (:222-225):

```css
/* Display-name field with the Profile button embedded at its right end. The button's width is
   one token so the input's right padding can reserve exactly that much room: a long name then
   ellipsizes before it reaches the button instead of running underneath it. */
.name-field {
  --home-profile-inline-w: 96px;
  position: relative;
  display: flex;
}
.name-field-input {
  flex: 1;
  min-width: 0;
  padding-right: calc(var(--home-profile-inline-w) + 10px);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* top/bottom insets (not top:50% + translateY) so the shared button:active translateY press
   doesn't fight a centering transform. */
.home-profile-inline {
  position: absolute;
  top: 5px;
  right: 5px;
  bottom: 5px;
  width: var(--home-profile-inline-w);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 10px 0 4px;
  background: var(--color-surface);
  color: var(--color-text-primary);
  border: 2px solid var(--color-border);
  border-radius: var(--radius-pill);
  box-shadow: none;
  font-family: var(--font-body);
  font-weight: 800;
  font-size: var(--text-caption);
  line-height: 1;
  white-space: nowrap;
}
.home-profile-inline:hover:not(:disabled) {
  background: var(--color-surface-raised);
  /* Restated per the hover convention: a background-only hover can strand a colour another
     rule set. */
  color: var(--color-text-primary);
}
.home-profile-inline:active:not(:disabled) {
  transform: translateY(1px);
}

/* "or" between Create Room and the code + Join row: a rule on each side of the word. */
.or-divider {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--color-text-faintest);
  font-family: var(--font-body);
  font-weight: 800;
  font-size: var(--text-caption);
  text-transform: lowercase;
}
.or-divider::before,
.or-divider::after {
  content: '';
  flex: 1;
  height: 2px;
  border-radius: 1px;
  background: var(--color-border);
}
```

- [ ] **Step 4: Typecheck.** Run `npm run typecheck --workspace @plantain/web`. Expected: exit 0.

- [ ] **Step 5: Re-run the browser check from Step 1.** Reload `/` and run the same snippet. Expected: `pass: true`, with `textOverflow: 'ellipsis'`, `whiteSpace: 'nowrap'`, `longNameOverflows: true`, `paddingClearsButton: true`, `buttonInsideInput: true`, `buttonText: 'Profile'`, `hasAvatar: true`, `oldProfileBtnGone: true`, `dictionaryStillInLinks: true`, `labelTargetsInput: true`, `divider: { text: 'or', between: true }`. Take a screenshot with a long name typed in, so the ellipsis is visible before the button.

- [ ] **Step 6: Check that the button navigates.** Run:

```js
(async () => {
  document.querySelector('.home-profile-inline').click();
  await new Promise((r) => setTimeout(r, 300));
  return location.pathname;
})()
```

Expected: `'/profile'`. Navigate back to `/`.

- [ ] **Step 7: Check for overflow at 280px.** Run `resize_window` with preset `mobile`, reload `/`, then run:

```js
(() => {
  document.head.insertAdjacentHTML('beforeend', '<style>*{transition:none!important}</style>');
  const root = document.getElementById('root');
  root.style.width = '280px';
  root.style.overflowX = 'auto';
  const edge = root.getBoundingClientRect().right;
  const offenders = [...root.querySelectorAll('*')]
    .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > edge + 0.5)
    .map((el) => `${el.tagName}.${el.className}`);
  const input = document.querySelector('#home-display-name');
  const btn = document.querySelector('.home-profile-inline').getBoundingClientRect();
  const ir = input.getBoundingClientRect();
  const cs = getComputedStyle(input);
  const join = document.querySelector('.join-row button').getBoundingClientRect();
  return {
    overflowing: root.scrollWidth > root.clientWidth,
    offenders: offenders.slice(0, 10),
    buttonInsideInput: btn.left >= ir.left && btn.right <= ir.right,
    textAreaPx: Math.round(input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
    joinButtonInside: join.right <= edge,
  };
})()
```

Expected: `overflowing: false`, `offenders: []`, `buttonInsideInput: true`, `joinButtonInside: true`, and `textAreaPx` ≥ 48 (about 60 by arithmetic: 280 − 2×32 page padding − 2×16 panel padding − 4 border − 14 left padding − 106 reserved). If `textAreaPx` comes out below 48, add `@media (max-width: 360px) { .name-field { --home-profile-inline-w: 84px; } .home-profile-inline { gap: 4px; padding-right: 8px; } }` after the `.home-profile-inline:active` rule and re-run. Then reset with `resize_window` preset `desktop`.

- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/pages/Home.tsx apps/web/src/styles.css
git commit -m "feat(home): embed Profile button in the name field, add 'or' divider before Join

The input reserves the button's width as right padding so long names ellipsize before it.
The standalone .home-profile-btn is removed from .home-links; My Dictionaries stays.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Prod migration handoff + project notes

**Files:**
- Modify: `CLAUDE.md` (append a dated entry to "Current status", before the `- ➡️ **Next up` line)

**Interfaces:** none (operational handoff).

- [ ] **Step 1: Write the handoff note for the user (in the final report, not a file).** Include exactly:
  1. **Apply `supabase/migrations/20261006000003_solo_peel_batch.sql` to prod BEFORE merging/pushing this branch to `main`.** Pushing to `main` auto-deploys the Worker (`deploy-worker.yml` triggers on `apps/api/**` and `packages/shared/**`). The new Worker always sends `p_peel_batch`, and against the old 5-argument function that call fails with "Could not find the function public.create_solo_room(...)", which breaks **every** solo game. The reverse order is safe: the migrated function's `default null` still accepts the currently deployed Worker's 5-argument call.
  2. How: Supabase dashboard → SQL editor → paste the file's contents **copied from the file in the editor, not from a chat message** (chat UIs can eat `$$ ... $$` bodies as LaTeX and turn `'` into `′`) → Run. Run it on its own, after every earlier migration has been applied (filename order).
  3. Check it worked by running in the same SQL editor:
     ```sql
     select proname, pg_get_function_identity_arguments(oid)
       from pg_proc
      where pronamespace = 'public'::regnamespace and proname in ('create_solo_room', 'peel');
     ```
     Expected: exactly 2 rows. `create_solo_room` → `p_host uuid, p_display_name text, p_dictionary_config jsonb, p_bunch_size integer, p_timed boolean, p_peel_batch integer`; `peel` → `p_room_id uuid, p_profile uuid, p_expected_count integer`.
  4. After the deploy, start one Quick solo game on plantainpieces.com with the slider at a non-default value. In the SQL editor, `select mode_config from rooms where mode = 'solo' order by created_at desc limit 1;` should show that `peelBatch`.

- [ ] **Step 2: Add the CLAUDE.md status entry.** Insert before the `- ➡️ **Next up: puzzle of the day, then bot opponent**` line:

```markdown
- ✅ **Solo peel batches + landing tidy (2026-10-06).** A solo Peel draws N tiles (1–7, "Tiles per
  peel" slider on `/solo`; defaults Quick 2 / Standard 3 / Full 5 on `BUNCH_SIZE_PRESETS`, reset on
  preset change). Stored as `rooms.mode_config.peelBatch` (camelCase beside `bunchSize`/`timed`, so
  Results' rematch round-trips it; absent → 1). Migration `20261006000003`: `create_solo_room` was
  **dropped and recreated** with a trailing `p_peel_batch int default null` (no overload; old 5-arg
  Worker calls still resolve), and `peel` gained a `mode = 'solo'` branch drawing
  `least(peelBatch, bunch_count)` with an explicit solo gate `bunch_count >= 1` (last Peel takes the
  remainder) plus `drawn` in the `peel` event payload; every other mode is byte-for-byte the old
  path. Clamp twins: SQL `least(7, greatest(1, ...))` ↔ shared `clampPeelBatch`; gate twins: SQL ↔
  shared `peelThreshold`. Verified by `scripts/smoke-solo-batch.mjs`. Landing: Profile button
  (avatar + "Profile") now sits inside the display-name input (`.name-field`, width token
  `--home-profile-inline-w` reserved as input padding so names ellipsize before it); "or" divider
  between Create Room and Join. ⚠️ `profile_stats.total_peels` ("Tiles peeled") still counts Peel
  *events*, not tiles, and `solo_best_times` is keyed by Bunch size only (batch sizes share a best
  time). Both were left as-is pending a product call.
```

- [ ] **Step 3: Commit.**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): record solo peel batches + landing changes and prod migration order

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-Review Against Spec 3.1 / 3.2

**3.1 Solo peel batches**

| Spec requirement | Where covered |
|---|---|
| Slider on solo setup, 1–7, integer | Task 4 (`type="range" min=1 max=7 step=1`, `clampPeelBatch` on change), browser check Step 4 |
| Defaults Quick 2 / Standard 3 / Full 5 | Task 1 (`defaultPeelBatch` on each preset, pinned by test), Task 4 Step 4 |
| Preset change resets slider | Task 4 (preset `onClick` calls `setPeelBatch(preset.defaultPeelBatch)`), checked by `resetOnPresetChange === '3'` |
| Stored in `rooms.mode_config` | Task 2 (`create_solo_room` writes it), Task 4 Step 5 reads it back from the DB |
| Worker validates 1–7 on `POST /rooms/solo` | Task 1 (`validateSoloModeConfig` → `INVALID_PEEL_BATCH`), Task 3 (400 mapping), Task 4 Step 6 (real HTTP) |
| `create_solo_room` clamps 1–7, default 1 if absent | Task 2 SQL + smoke (null/0/-5/99/3/omitted) |
| `peel` exact signature, solo draws `least(batch, bunch)`, gate `>= 1`, last takes remainder | Task 2 (`create or replace` on the same signature; smoke asserts one overload, 7/7/5 remainder, gate at 1) |
| Other modes unchanged | Task 2 (multiplayer smoke: 1 per player; `smoke-xtina.mjs` re-run) |
| Peel `room_event` carries drawn count | Task 2 (`drawn` in payload; smoke asserts 7, 5, 1, and 1 in multiplayer) |
| Client `runAutoAction` gate uses `>= 1` for solo | Task 5 (`peelThreshold`) |
| Slice-fly animates N staggered | Task 5 Step 3. The existing effect already handles bursts larger than one wave (built for xtina's 10-tile deals), so this is a comment-only change. The live N-slice animation is verified only if a full board gets solved in the browser; otherwise it is reported as unverified |
| Defaults table next to `BUNCH_SIZE_PRESETS` | Task 1 |

**Deviations from the spec, all deliberate:**
1. **Key name `peelBatch`, not `peel_batch`.** Every existing `mode_config` key is camelCase (`bunchSize`, `timed`, `partnerId`, `step`, `puzzleId`). More importantly, `Results.tsx:208` rematches a solo game by passing `room.mode_config` straight back as a `SoloModeConfig`. With a snake_case key, a rematch would silently drop the batch size.
2. **`BUNCH_SIZE_PRESETS` lives in `packages/shared/src/solo.ts`, not `tiles.ts`.** The defaults go on the preset objects themselves (the literal meaning of "next to"). Nothing moves files.
3. **The setup screen is the page `SoloSetup.tsx`, not `SoloSetupModal.tsx`.** It became a full page some time after the spec's source material was written.
4. **`create_solo_room` changes signature** (drop + recreate with a defaulted trailing argument). It cannot take a new input under its exact old signature. The no-overload rule is kept, and the precedent is `20260911000002`. `peel` does keep its exact signature. Deploy order is covered in Task 7.

**Gaps found and NOT closed, flagged for a product decision (out of Phase 3's literal scope):**
- The spec says *"'Tiles peeled' counts tiles drawn, so it naturally reflects batches."* **That is false today.** The Profile stat labelled "Tiles peeled" (`Profile.tsx:563`) shows `profile_stats.total_peels`, which `_archive_game_impl` (latest in `20260924000003_daily_stats_archive.sql`) fills with `count(*)` of the player's `peel` events. A batch-7 solo game with 5 Peels records 5, not 35. Fixing it means redefining `_archive_game_impl` to sum `coalesce((payload->>'drawn')::int, 1)` for solo, and the new `drawn` field from Task 2 makes that a small, safe follow-up. Whether the multiplayer number should mean "Peels you called" or "tiles you received" is a product question, so it was left out rather than guessed.
- `profile_stats.solo_best_times` is keyed by Bunch size only (`20260918000002`). A batch-7 time and a batch-1 time on the same Bunch size compete for one "best time". Re-keying (e.g. `"54:7"`) is a separate migration plus a Profile UI change.
- Client gate: for a 1-player solo room the old `bunch >= activeCount` already evaluated to `bunch >= 1`. Task 5 makes the intent explicit and mode-driven. It does not fix a bug anyone could actually hit.

**3.2 Landing page**

| Spec requirement | Where covered |
|---|---|
| Smaller Profile button (avatar + "Profile") inside right end of name input | Task 6 (`.home-profile-inline`, 22px avatar, absolute inside `.name-field`), checks `buttonInsideInput`, `buttonText`, `hasAvatar` |
| Input right padding = button width, long names ellipsize before button | Task 6 (`padding-right: calc(var(--home-profile-inline-w) + 10px)`, `text-overflow: ellipsis` + `nowrap` + `overflow: hidden`), checks `paddingClearsButton`, `longNameOverflows`, `textOverflow` |
| Remove `.home-profile-btn` from `.home-links`; dictionary button stays | Task 6 (JSX + CSS deletion + flat-press list updated), checks `oldProfileBtnGone`, `dictionaryStillInLinks` |
| Divider with centered "or" between Create Room and code + Join | Task 6 (`.or-divider`), check `divider.between` |
| Keep mobile fixes; `min-width: 0` on flex inputs; no overflow at 280px | Task 6 (`.name-field-input { flex: 1; min-width: 0 }`, `.join-row` untouched), Step 7 hard-width 280px check |

Also handled: the old `<label className="field">` wrapper became a `div` with `label htmlFor`, because a button nested inside a `<label>` is invalid interactive content (checked by `labelTargetsInput`). The new hover rule restates `color`, per the CLAUDE.md convention.

**Placeholder scan:** no TBD/TODO. Every step has a real command, real code and expected output. The only conditional instructions are the migration-suffix bump (Task 2 Files) and the narrow-width fallback (Task 6, Step 7), and both spell out the exact action.
