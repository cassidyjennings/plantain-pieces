# Xtina Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a hidden, account-gated two-player mode in which the Bunch is scripted so the partner account is dealt exactly one word's tiles at a time to construct a fixed 10-word crossword, while the owner account is dealt only `X` and `Z`.

**Architecture:** Server-authoritative for anything that must survive a reload — the scripted Bunch, the per-step deal, and the role gating all live in Postgres RPCs called by the Worker. Hints, accent colors and the placement gate are pure presentation and live entirely in the React client, driven by one shared board specification in `packages/shared`. No new screens and no new client-facing entry point: the mode activates inside the existing `start_game` path.

**Tech Stack:** TypeScript, React 18 + Vite, Zustand, Supabase Postgres (plpgsql `SECURITY DEFINER` RPCs), Cloudflare Worker (Hono), vitest.

**Spec:** `docs/superpowers/specs/2026-08-05-xtina-mode-design.md`

## Global Constraints

- **Package manager is `npm`, not pnpm.** Never invoke pnpm or Corepack.
- **Shell is PowerShell on Windows.** No inline `VAR=x cmd` prefix — use `$env:VAR = '...'` on its own line.
- **No client writes to game tables.** Every mutation is an RPC called by the Worker with the service role. Do not add INSERT/UPDATE RLS policies for `authenticated`.
- **New RPCs must be revoked from `public`, `anon`, `authenticated` and granted to `service_role`** in a `do $$ ... $$` block, matching every existing action RPC.
- **`create or replace` on an existing function must keep the argument types byte-identical.** A changed signature registers a *second* overload and makes named-argument `.rpc()` calls ambiguous with `function is not unique`.
- **Migrations run in filename order, one at a time.** A skipped migration fails LATER with a confusing error pointing at the wrong file.
- **No account UUID may be committed to this repository.** Roles are assigned by hand in the Supabase SQL editor.
- Board origin is fixed: `YOURE`'s `Y` at cell **(18, 22)**.
- Scripted Bunch is exactly **70 tiles** — 56 partner, 14 owner. This is arithmetic, not a tunable: `peel` requires `bunch_count >= 2` and `finish_game` requires `bunch_count < 2`, so it must reach 0 as `LOVE`'s tiles are dealt.
- Hint outlines show **cells only, never letters**.
- Commit message trailer: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

## File Structure

**Create:**
- `packages/shared/src/xtina.ts` — the board specification and every function derived from it. Single source of truth for words, anchors, per-step cells, per-step letters, accent cells, the Bunch composition, and the placement gate.
- `packages/shared/test/xtina.test.ts` — vitest proving the spec is internally consistent and matches the design. **Tests in this workspace live in `test/`, not colocated in `src/`, and import from `'../src/index.js'`** — follow that convention.
- `supabase/migrations/20260805000001_xtina_roles.sql` — profile role/toggle columns, `set_xtina_enabled`, `rooms.mode` constraint.
- `supabase/migrations/20260805000002_xtina_deal.sql` — scripted Bunch/deal helpers plus the `start_game`, `peel` and `archive_game` replacements.
- `scripts/smoke-xtina.mjs` — scripted `pg` test driving a full scripted game against the local database.
- `apps/web/src/components/XtinaToggle.tsx` — the owner-only on/off control.

**Modify:**
- `packages/shared/src/index.ts` — export the new module.
- `apps/api/src/index.ts` — toggle route; dump block; plantains dictionary skip; summary skip.
- `apps/web/src/lib/api.ts` — `setXtinaEnabled` client method.
- `apps/web/src/lib/profile.ts` — surface `xtina_role` / `xtina_enabled` on `ProfileRow`.
- `apps/web/src/store/sessionStore.ts` — hold the two new profile fields.
- `apps/web/src/lib/rooms.ts` — widen `PublicRoom.mode` and `mode_config`.
- `apps/web/src/components/GameBoard.tsx` — `hintCells` and `accentCells` props.
- `apps/web/src/styles.css` — hint outline and accent tile styles.
- `apps/web/src/pages/Game.tsx` — hint derivation, placement gate, Dump hiding, endgame hold.
- `apps/web/src/pages/Profile.tsx` — mount `XtinaToggle` in the Overview tab.
- `packages/shared/src/avatar.ts` — `'stina'` base option.
- `apps/web/src/components/Avatar.tsx` — render the new base.
- `apps/web/src/components/WordSetEditor.tsx` is **not** touched. No dictionary changes are part of this plan.

---

## Task 1: Shared board specification

Pure TypeScript with no dependencies beyond existing shared helpers. Everything downstream — hints, colors, the gate, the SQL literals, the Bunch — is derived from one table, so the design can't drift out of sync with itself.

**Files:**
- Create: `packages/shared/src/xtina.ts`
- Create: `packages/shared/test/xtina.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `makeKey`, `extractWords`, `isConnected`, `findOrphans` from `./grid.js`; `GridState`, `Letter`, `LetterCounts` from `./types.js`.
- Produces: `XtinaWord`, `XTINA_WORDS`, `XTINA_STEPS`, `xtinaWordCells(w)`, `xtinaTarget(step)`, `xtinaHintCells(step)`, `xtinaStepLetters(step)`, `xtinaAccentCells()`, `xtinaGridMatches(grid, step)`, `xtinaBunch()`, `XTINA_BUNCH_SIZE`, `XTINA_OWNER_TILES`, `XTINA_OWNER_DEAL`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/xtina.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  extractWords,
  isConnected,
  findOrphans,
  XTINA_WORDS,
  XTINA_STEPS,
  XTINA_BUNCH_SIZE,
  XTINA_OWNER_TILES,
  XTINA_OWNER_DEAL,
  xtinaTarget,
  xtinaHintCells,
  xtinaStepLetters,
  xtinaAccentCells,
  xtinaGridMatches,
  xtinaBunch,
} from '../src/index.js';

const EXPECTED_WORDS = [
  'YOURE', 'BEAUTIFUL', 'INTELLIGENT', 'CARING', 'STRONG',
  'HILARIOUS', 'SPECIAL', 'DRIVEN', 'MY', 'LOVE',
];

describe('xtina board spec', () => {
  it('deals the ten words in the required order', () => {
    expect(XTINA_WORDS.map((w) => w.word)).toEqual(EXPECTED_WORDS);
    expect(XTINA_STEPS).toBe(10);
    // YOURE first, MY second-to-last, LOVE last.
    expect(XTINA_WORDS[0].word).toBe('YOURE');
    expect(XTINA_WORDS[XTINA_STEPS - 2].word).toBe('MY');
    expect(XTINA_WORDS[XTINA_STEPS - 1].word).toBe('LOVE');
  });

  it('anchors YOURE at (18,22)', () => {
    expect(xtinaTarget(1)).toEqual({
      '18,22': 'Y', '19,22': 'O', '20,22': 'U', '21,22': 'R', '22,22': 'E',
    });
  });

  it('places 56 cells in total', () => {
    expect(Object.keys(xtinaTarget(XTINA_STEPS))).toHaveLength(56);
  });

  it('stays connected and orphan-free at every step', () => {
    for (let step = 1; step <= XTINA_STEPS; step++) {
      const grid = xtinaTarget(step);
      expect(isConnected(grid), `step ${step} connected`).toBe(true);
      expect(findOrphans(grid), `step ${step} orphans`).toEqual([]);
    }
  });

  it('extracts to exactly the ten intended words and no accidental ones', () => {
    const found = extractWords(xtinaTarget(XTINA_STEPS)).sort();
    expect(found).toEqual([...EXPECTED_WORDS].sort());
  });

  it('deals the documented number of new tiles per step', () => {
    const counts = Array.from({ length: XTINA_STEPS }, (_, i) => xtinaStepLetters(i + 1).length);
    expect(counts).toEqual([5, 8, 10, 5, 5, 8, 6, 5, 1, 3]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(56);
  });

  it('deals exactly the letters of the cells it hints', () => {
    for (let step = 1; step <= XTINA_STEPS; step++) {
      expect(xtinaStepLetters(step)).toHaveLength(xtinaHintCells(step).size);
    }
  });

  it('never hints a cell that is already occupied', () => {
    for (let step = 2; step <= XTINA_STEPS; step++) {
      const occupied = new Set(Object.keys(xtinaTarget(step - 1)));
      for (const key of xtinaHintCells(step)) {
        expect(occupied.has(key), `step ${step} hints occupied ${key}`).toBe(false);
      }
    }
  });

  it('accents exactly the cells of YOURE, MY and LOVE', () => {
    const accent = xtinaAccentCells();
    // YOURE (5) + MY (2) + LOVE (4), minus the Y and L each shares = 9 distinct cells.
    expect(accent.size).toBe(9);
    expect(accent.has('18,22')).toBe(true); // shared Y of YOURE/MY
    expect(accent.has('18,21')).toBe(true); // M of MY
    expect(accent.has('20,27')).toBe(true); // shared L of BEAUTIFUL/LOVE
    expect(accent.has('20,19')).toBe(false); // B of BEAUTIFUL is not accented
  });

  it('sizes the bunch so it lands on exactly zero', () => {
    const bunch = xtinaBunch();
    const total = Object.values(bunch).reduce((a, b) => a + b, 0);
    expect(total).toBe(XTINA_BUNCH_SIZE);
    expect(total).toBe(70);

    let remaining = total;
    remaining -= xtinaStepLetters(1).length + XTINA_OWNER_DEAL; // Split
    expect(remaining).toBe(60);
    for (let step = 2; step <= XTINA_STEPS; step++) {
      // Every peel must be legal: two active players need two tiles available.
      expect(remaining, `bunch before peel to step ${step}`).toBeGreaterThanOrEqual(2);
      remaining -= xtinaStepLetters(step).length + 1;
    }
    expect(remaining).toBe(0);
  });

  it('gives the owner 14 junk tiles, all X or Z', () => {
    expect(XTINA_OWNER_TILES).toHaveLength(XTINA_OWNER_DEAL + (XTINA_STEPS - 1));
    expect(XTINA_OWNER_TILES).toHaveLength(14);
    expect(new Set(XTINA_OWNER_TILES)).toEqual(new Set(['X', 'Z']));
  });

  it('matches a grid only when it equals the cumulative target exactly', () => {
    expect(xtinaGridMatches(xtinaTarget(2), 2)).toBe(true);
    expect(xtinaGridMatches(xtinaTarget(1), 2)).toBe(false);
    expect(xtinaGridMatches(xtinaTarget(3), 2)).toBe(false);
    // Right letters, wrong place: shift YOURE one cell right.
    const shifted = { '19,22': 'Y', '20,22': 'O', '21,22': 'U', '22,22': 'R', '23,22': 'E' };
    expect(xtinaGridMatches(shifted, 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test:shared -- xtina
```

Expected: FAIL — the `xtina*` symbols are not exported from `../src/index.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/xtina.ts`:

```ts
/**
 * Xtina mode — the scripted board.
 *
 * A hidden two-player mode: the partner account is dealt exactly one word's tiles at a time and
 * builds a fixed 10-word crossword; the owner account is dealt only X and Z and can never form a
 * word. This module is the single source of truth for the whole thing — hint outlines, accent
 * colors, the placement gate, the Bunch composition and the per-step deal are all DERIVED from
 * XTINA_WORDS rather than restated, so the pieces cannot drift apart.
 *
 * The per-step letter arrays have a hand-written twin in SQL (`_xtina_step_letters`), the same
 * keep-in-sync arrangement this repo already uses for TILE_DISTRIBUTION/_fresh_bunch() and
 * scaledBunchDistribution/_scaled_bunch. scripts/smoke-xtina.mjs asserts the two agree.
 */
import { makeKey } from './grid.js';
import type { GridState, Letter, LetterCounts } from './types.js';

export interface XtinaWord {
  word: string;
  /** Cell of the word's first letter. */
  x: number;
  y: number;
  dir: 'H' | 'V';
  /** Rendered in the accent color rather than the ordinary tile color. */
  accent: boolean;
}

/**
 * Deal order. Every entry after the first shares exactly one cell with a word already placed, so
 * the grid is connected and orphan-free at every step — which matters because Peel auto-fires on
 * STRUCTURAL validity (all tiles placed, connected, no orphans), checked long before any
 * dictionary lookup.
 *
 * Ordering is fixed by the design: YOURE first, MY second-to-last, LOVE last.
 */
export const XTINA_WORDS: XtinaWord[] = [
  { word: 'YOURE',       x: 18, y: 22, dir: 'H', accent: true  },
  { word: 'BEAUTIFUL',   x: 20, y: 19, dir: 'V', accent: false }, // shares U @20,22
  { word: 'INTELLIGENT', x: 20, y: 24, dir: 'H', accent: false }, // shares I @20,24
  { word: 'CARING',      x: 29, y: 20, dir: 'V', accent: false }, // shares N @29,24
  { word: 'STRONG',      x: 27, y: 22, dir: 'H', accent: false }, // shares R @29,22
  { word: 'HILARIOUS',   x: 25, y: 22, dir: 'V', accent: false }, // shares L @25,24
  { word: 'SPECIAL',     x: 25, y: 30, dir: 'H', accent: false }, // shares S @25,30
  { word: 'DRIVEN',      x: 29, y: 28, dir: 'V', accent: false }, // shares I @29,30
  { word: 'MY',          x: 18, y: 21, dir: 'V', accent: true  }, // shares Y @18,22
  { word: 'LOVE',        x: 20, y: 27, dir: 'H', accent: true  }, // shares L @20,27
];

export const XTINA_STEPS = XTINA_WORDS.length;

/**
 * The owner's tiles for the entire game, in draw order: the first XTINA_OWNER_DEAL at Split, then
 * one per Peel. Deliberately nothing but X and Z, so no word is ever possible.
 */
export const XTINA_OWNER_TILES: Letter[] = [
  'X', 'Z', 'X', 'Z', 'X', 'Z', 'X', 'Z', 'X', 'Z', 'X', 'Z', 'X', 'Z',
];

/** Both players are dealt the same count at Split so the public tile-count pills stay symmetric. */
export const XTINA_OWNER_DEAL = 5;

/** Cells a word occupies, in reading order. */
export function xtinaWordCells(w: XtinaWord): { key: string; letter: Letter }[] {
  return [...w.word].map((letter, i) => ({
    key: w.dir === 'H' ? makeKey(w.x + i, w.y) : makeKey(w.x, w.y + i),
    letter,
  }));
}

/** The cumulative finished grid after `step` words (1-based). `xtinaTarget(0)` is empty. */
export function xtinaTarget(step: number): GridState {
  const grid: GridState = {};
  for (const w of XTINA_WORDS.slice(0, step)) {
    for (const { key, letter } of xtinaWordCells(w)) grid[key] = letter;
  }
  return grid;
}

/**
 * The cells word `step` adds that are not already occupied — i.e. exactly the dotted outlines to
 * draw. A word's shared hook letter is already on the board and is never hinted.
 */
export function xtinaHintCells(step: number): Set<string> {
  const occupied = new Set(Object.keys(xtinaTarget(step - 1)));
  const keys = xtinaWordCells(XTINA_WORDS[step - 1]).map((c) => c.key);
  return new Set(keys.filter((k) => !occupied.has(k)));
}

/** The letters dealt at `step` — by construction, one per hinted cell. */
export function xtinaStepLetters(step: number): Letter[] {
  const hinted = xtinaHintCells(step);
  return xtinaWordCells(XTINA_WORDS[step - 1])
    .filter((c) => hinted.has(c.key))
    .map((c) => c.letter);
}

/** Cells belonging to an accent word (YOURE, MY, LOVE), including their shared letters. */
export function xtinaAccentCells(): Set<string> {
  const keys = new Set<string>();
  for (const w of XTINA_WORDS) {
    if (!w.accent) continue;
    for (const { key } of xtinaWordCells(w)) keys.add(key);
  }
  return keys;
}

/**
 * Whether the player's grid is exactly the cumulative target for `step`. This is the soft gate:
 * tiles placed anywhere else simply don't advance the script — no error, no rejected drag.
 */
export function xtinaGridMatches(grid: GridState, step: number): boolean {
  const target = xtinaTarget(step);
  const targetKeys = Object.keys(target);
  if (Object.keys(grid).length !== targetKeys.length) return false;
  return targetKeys.every((k) => grid[k] === target[k]);
}

/**
 * The scripted Bunch: every tile either player will ever be dealt, and not one more. Sized so
 * bunch_count reaches exactly 0 as LOVE's letters are dealt, which is what makes the client's
 * auto-action fire Plantains instead of a tenth Peel with no endgame special-casing.
 */
export function xtinaBunch(): LetterCounts {
  const counts: LetterCounts = {};
  const add = (l: Letter) => { counts[l] = (counts[l] ?? 0) + 1; };
  for (let step = 1; step <= XTINA_STEPS; step++) xtinaStepLetters(step).forEach(add);
  XTINA_OWNER_TILES.forEach(add);
  return counts;
}

export const XTINA_BUNCH_SIZE = 70;
```

- [ ] **Step 4: Export the module**

In `packages/shared/src/index.ts`, add after the `solo.js` line:

```ts
export * from './xtina.js';
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm run test:shared
```

Expected: PASS — all pre-existing tests plus the new `xtina board spec` suite.

- [ ] **Step 6: Print the derived Bunch, to be transcribed into SQL in Task 3**

```bash
node -e "import('./packages/shared/dist/index.js').then(m=>console.log(JSON.stringify(m.xtinaBunch())))"
```

Run `npm run build:shared` first if `dist/` is stale. Expected output (key order may differ):

```
{"Y":1,"O":4,"U":3,"R":4,"E":7,"B":1,"A":4,"T":4,"I":6,"F":1,"L":4,"N":4,"G":3,"C":2,"S":2,"H":1,"P":1,"D":1,"V":2,"M":1,"X":7,"Z":7}
```

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/xtina.ts packages/shared/test/xtina.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add the xtina mode board specification"
```

---

## Task 2: Role and toggle migration

The gating half of the database work, kept in its own migration so it can be applied and verified before anything touches the game engine.

**Files:**
- Create: `supabase/migrations/20260805000001_xtina_roles.sql`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `profiles.xtina_role text`, `profiles.xtina_enabled boolean`, RPC `public.set_xtina_enabled(p_profile uuid, p_on boolean) returns jsonb`, and `'xtina'` as a legal `rooms.mode`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260805000001_xtina_roles.sql`:

```sql
-- Xtina mode — roles and the arming toggle.
--
-- Two accounts matter: the OWNER (may arm the mode) and the PARTNER (the script targets them).
-- Both are assigned by hand in the SQL editor against real profile UUIDs; deliberately no UUID
-- is committed to the repo and no UI lists or selects users.
--
-- Neither role can be a guest: an anonymous auth.users row is created fresh per session, so a
-- role set on one would evaporate on the next visit. Assign roles only to OAuth-linked accounts.

alter table public.profiles
  add column if not exists xtina_role text
    check (xtina_role in ('owner', 'partner')),
  add column if not exists xtina_enabled boolean not null default false;

comment on column public.profiles.xtina_role is
  'owner = may arm xtina mode; partner = the account the scripted deal targets. NULL for everyone else.';
comment on column public.profiles.xtina_enabled is
  'Whether xtina mode is armed. Only meaningful on the owner row.';

-- rooms.mode gains a third value. The column was created with an inline check in
-- 20260721000001, so the constraint has to be dropped by its generated name and rebuilt.
alter table public.rooms drop constraint if exists rooms_mode_check;
alter table public.rooms
  add constraint rooms_mode_check check (mode in ('multiplayer', 'solo', 'xtina'));

-- ---------------------------------------------------------------------------
-- set_xtina_enabled — the on/off button. Owner-only; the role check is the whole point of the
-- function existing rather than opening profiles.xtina_enabled to a client write.
-- ---------------------------------------------------------------------------
create or replace function public.set_xtina_enabled(p_profile uuid, p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  select xtina_role into v_role from public.profiles where id = p_profile;
  if v_role is distinct from 'owner' then
    raise exception 'NOT_XTINA_OWNER' using errcode = 'P0001';
  end if;

  update public.profiles set xtina_enabled = p_on where id = p_profile;
  return jsonb_build_object('ok', true, 'enabled', p_on);
end;
$$;

-- Worker (service_role) only, same lockdown as every other action RPC.
do $$
begin
  execute 'revoke all on function public.set_xtina_enabled(uuid,boolean) from public, anon, authenticated';
  execute 'grant execute on function public.set_xtina_enabled(uuid,boolean) to service_role';
end $$;
```

- [ ] **Step 2: Apply it and verify it fails for a non-owner**

```bash
npm run db:reset
```

Then, against the local database, confirm the guard actually fires. Create `scripts/smoke-xtina.mjs` with just this much for now:

```js
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
```

- [ ] **Step 3: Run the smoke test**

```bash
node scripts/smoke-xtina.mjs
```

Expected: four `ok` lines and `all smoke checks passed`. If `pg` is not resolvable, install it at the root with `npm install --save-dev pg` (the dictionary seeder already depends on it, so it is most likely present).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260805000001_xtina_roles.sql scripts/smoke-xtina.mjs
git commit -m "feat(db): add xtina owner/partner roles and the arming toggle"
```

---

## Task 3: Scripted deal migration

The engine half. `start_game` and `peel` are replaced with **byte-identical signatures** so no second overload is registered.

**Files:**
- Create: `supabase/migrations/20260805000002_xtina_deal.sql`
- Modify: `scripts/smoke-xtina.mjs`

**Interfaces:**
- Consumes: `profiles.xtina_role` / `profiles.xtina_enabled` from Task 2; the letter arrays printed in Task 1 Step 6.
- Produces: `_xtina_step_letters(int) returns text[]`, `_xtina_owner_tile(int) returns text`, `_xtina_bunch() returns jsonb`, `_xtina_take(uuid, text[]) returns void`; `start_game` and `peel` gain an xtina branch; `archive_game` early-returns. `rooms.mode_config` for an xtina room is `{"partnerId": uuid, "step": int}`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260805000002_xtina_deal.sql`:

```sql
-- Xtina mode — the scripted Bunch and deal.
--
-- start_game and peel are replaced with BYTE-IDENTICAL signatures. Changing the argument types
-- would register a second overload alongside the original and make named-argument .rpc() calls
-- ambiguous ("function is not unique"); create-or-replace also preserves the existing
-- service_role-only grants, so no re-lockdown is needed for those two.

-- ---------------------------------------------------------------------------
-- The script. Twin of packages/shared/src/xtina.ts — keep both in sync; scripts/smoke-xtina.mjs
-- asserts they agree. A CASE rather than a 2-D array literal: PostgreSQL rejects
-- array[array[...], array[...]] when the inner arrays have different lengths.
-- ---------------------------------------------------------------------------
create or replace function public._xtina_step_letters(p_step int)
returns text[]
language sql
immutable
as $$
  select case p_step
    when 1  then array['Y','O','U','R','E']                          -- YOURE
    when 2  then array['B','E','A','T','I','F','U','L']              -- BEAUTIFUL (U shared)
    when 3  then array['N','T','E','L','L','I','G','E','N','T']      -- INTELLIGENT (I shared)
    when 4  then array['C','A','R','I','G']                          -- CARING (N shared)
    when 5  then array['S','T','O','N','G']                          -- STRONG (R shared)
    when 6  then array['H','I','A','R','I','O','U','S']              -- HILARIOUS (L shared)
    when 7  then array['P','E','C','I','A','L']                      -- SPECIAL (S shared)
    when 8  then array['D','R','V','E','N']                          -- DRIVEN (I shared)
    when 9  then array['M']                                          -- MY (Y shared)
    when 10 then array['O','V','E']                                  -- LOVE (L shared)
  end;
$$;

-- The owner's tiles for the whole game, in draw order: indices 1..5 at Split, 6..14 one per Peel.
create or replace function public._xtina_owner_tile(p_index int)
returns text
language sql
immutable
as $$
  select (array['X','Z','X','Z','X','Z','X','Z','X','Z','X','Z','X','Z'])[p_index];
$$;

-- 70 tiles: 56 for the partner (the ten words) + 14 for the owner (X/Z). Sized so bunch_count
-- reaches exactly 0 as LOVE's letters are dealt — peel requires bunch_count >= 2 and finish_game
-- requires bunch_count < 2, so this is arithmetic, not a tunable.
create or replace function public._xtina_bunch()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'A', 4, 'B', 1, 'C', 2, 'D', 1, 'E', 7, 'F', 1, 'G', 3, 'H', 1,
    'I', 6, 'L', 4, 'M', 1, 'N', 4, 'O', 4, 'P', 1, 'R', 4, 'S', 2,
    'T', 4, 'U', 3, 'V', 2, 'Y', 1,
    'X', 7, 'Z', 7
  );
$$;

-- Remove named letters from the Bunch. Deliberately NOT _draw_from_bunch, which draws at random —
-- the whole point here is that the deal is deterministic.
create or replace function public._xtina_take(p_room_id uuid, p_letters text[])
returns void
language plpgsql
as $$
declare
  v_bunch jsonb;
  v_letter text;
  v_have int;
begin
  select bunch into v_bunch from public.rooms where id = p_room_id;
  foreach v_letter in array p_letters loop
    v_have := coalesce((v_bunch ->> v_letter)::int, 0);
    if v_have < 1 then
      raise exception 'XTINA_BUNCH_DESYNC' using errcode = 'P0001';
    end if;
    v_bunch := jsonb_set(v_bunch, array[v_letter], to_jsonb(v_have - 1));
  end loop;
  update public.rooms
    set bunch = v_bunch,
        bunch_count = bunch_count - coalesce(array_length(p_letters, 1), 0)
    where id = p_room_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- start_game — identical to 20260720000002 except for the xtina branch. Falls through to the
-- ordinary random deal unless ALL of: host is an armed owner, exactly two non-spectators, and
-- the other one is the partner.
-- ---------------------------------------------------------------------------
create or replace function public.start_game(p_room_id uuid, p_host uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_players int;
  v_deal int;
  v_player record;
  v_tiles text[];
  v_armed boolean;
  v_partner uuid;
  v_i int;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_room.host_id <> p_host then raise exception 'NOT_HOST' using errcode = 'P0001'; end if;
  if v_room.status <> 'lobby' then raise exception 'ALREADY_STARTED' using errcode = 'P0001'; end if;

  select count(*) into v_players
    from public.room_players where room_id = p_room_id and not is_spectator;
  if v_players < 1 then raise exception 'NEED_ONE_PLAYER' using errcode = 'P0001'; end if;

  select (xtina_role = 'owner' and xtina_enabled) into v_armed
    from public.profiles where id = p_host;

  if coalesce(v_armed, false) and v_players = 2 then
    select rp.profile_id into v_partner
      from public.room_players rp
      join public.profiles p on p.id = rp.profile_id
     where rp.room_id = p_room_id and not rp.is_spectator
       and rp.profile_id <> p_host and p.xtina_role = 'partner';
  end if;

  if v_partner is not null then
    -- Scripted path. Seed the exact Bunch, deal word 1 to the partner and junk to the owner.
    update public.rooms
      set bunch = public._xtina_bunch(),
          bunch_count = 70,
          mode = 'xtina',
          mode_config = jsonb_build_object('partnerId', v_partner, 'step', 1)
      where id = p_room_id;

    v_tiles := public._xtina_step_letters(1);
    perform public._xtina_take(p_room_id, v_tiles);
    update public.room_players
      set rack = to_jsonb(v_tiles), tile_count = array_length(v_tiles, 1), grid_state = '{}'::jsonb
      where room_id = p_room_id and profile_id = v_partner;

    v_tiles := array[]::text[];
    for v_i in 1..5 loop
      v_tiles := v_tiles || public._xtina_owner_tile(v_i);
    end loop;
    perform public._xtina_take(p_room_id, v_tiles);
    update public.room_players
      set rack = to_jsonb(v_tiles), tile_count = array_length(v_tiles, 1), grid_state = '{}'::jsonb
      where room_id = p_room_id and profile_id = p_host;

    v_deal := 5;
  else
    v_deal := public._initial_deal(v_players);

    for v_player in
      select profile_id from public.room_players
      where room_id = p_room_id and not is_spectator order by seat
    loop
      v_tiles := public._draw_from_bunch(p_room_id, v_deal);
      update public.room_players
        set rack = to_jsonb(v_tiles), tile_count = array_length(v_tiles, 1), grid_state = '{}'::jsonb
        where room_id = p_room_id and profile_id = v_player.profile_id;
    end loop;
  end if;

  update public.rooms set status = 'active', started_at = now() where id = p_room_id;

  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'game_started',
          jsonb_build_object('dealt', v_deal,
                             'bunchCount', (select bunch_count from public.rooms where id = p_room_id),
                             'tileCounts', public._tile_counts(p_room_id)));

  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- peel — identical to 20260706000002 except for the xtina branch. The stale-peel guard
-- (p_expected_count) and the BUNCH_TOO_LOW gate are untouched and still apply.
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
  v_partner uuid;
  v_step int;
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

  if v_room.bunch_count < v_active then
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
          tile_count = rp.tile_count + coalesce(array_length(v_tiles, 1), 0)
      where rp.room_id = p_room_id and rp.profile_id = v_partner;

    -- Owner: one more junk tile. Index 5 was the last dealt at Split, so step 2 draws index 6.
    v_tiles := array[public._xtina_owner_tile(4 + v_step)];
    perform public._xtina_take(p_room_id, v_tiles);
    update public.room_players rp
      set rack = rp.rack || to_jsonb(v_tiles),
          tile_count = rp.tile_count + 1
      where rp.room_id = p_room_id and rp.profile_id = v_room.host_id;

    update public.rooms
      set mode_config = jsonb_set(mode_config, '{step}', to_jsonb(v_step))
      where id = p_room_id;
  else
    for v_player in
      select profile_id from public.room_players
      where room_id = p_room_id and not is_spectator order by seat
    loop
      v_tiles := public._draw_from_bunch(p_room_id, 1);
      update public.room_players rp
        set rack = rp.rack || to_jsonb(v_tiles),
            tile_count = rp.tile_count + coalesce(array_length(v_tiles, 1), 0)
        where rp.room_id = p_room_id and rp.profile_id = v_player.profile_id;
    end loop;
  end if;

  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'peel',
          jsonb_build_object('actor', p_profile,
                             'bunchCount', (select bunch_count from public.rooms where id = p_room_id),
                             'tileCounts', public._tile_counts(p_room_id)));

  select rack into v_new_rack from public.room_players
    where room_id = p_room_id and profile_id = p_profile;
  return jsonb_build_object('ok', true, 'rack', v_new_rack,
                            'bunchCount', (select bunch_count from public.rooms where id = p_room_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- archive_game — an xtina game must not touch lifetime stats, the play streak, or achievements.
-- Marks the room applied so the Worker's normal call is a clean no-op rather than a repeated
-- attempt.
-- ---------------------------------------------------------------------------
create or replace function public.archive_game(p_room_id uuid, p_winner uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode text;
begin
  select mode into v_mode from public.rooms where id = p_room_id;
  if v_mode = 'xtina' then
    update public.rooms set stats_applied = true where id = p_room_id;
    return jsonb_build_object('ok', true, 'roomId', p_room_id, 'skipped', 'xtina');
  end if;
  return public._archive_game_impl(p_room_id, p_winner);
end;
$$;
```

> **Implementation note for Step 1.** The `archive_game` wrapper above delegates to
> `_archive_game_impl`. Create that by copying the **entire current body** of `archive_game` from
> `supabase/migrations/20260728000006_stats_scale_with_users.sql` (starting at its
> `create or replace function public.archive_game` on line 102) into this migration **renamed** to
> `public._archive_game_impl(p_room_id uuid, p_winner uuid)`, unchanged in every other respect.
> Place it **above** the wrapper. Then add the lockdown block below. Splitting it this way keeps
> the ~200-line stats rollup from being duplicated-and-edited, so a future change to the rollup
> touches one function.

```sql
do $$
begin
  execute 'revoke all on function public._archive_game_impl(uuid,uuid) from public, anon, authenticated';
  execute 'grant execute on function public._archive_game_impl(uuid,uuid) to service_role';
  execute 'revoke all on function public._xtina_take(uuid,text[]) from public, anon, authenticated';
  execute 'grant execute on function public._xtina_take(uuid,text[]) to service_role';
end $$;
```

- [ ] **Step 2: Extend the smoke test to drive a whole scripted game**

Append to `scripts/smoke-xtina.mjs`, inside `main()` before `await client.end()`:

```js
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
```

- [ ] **Step 3: Apply and run**

```bash
npm run db:reset
```

```bash
npm run build:shared
```

```bash
node scripts/smoke-xtina.mjs
```

Expected: every check prints `ok`, ending with `all smoke checks passed`.

If `create_room`'s return shape does not expose the room id under any of `roomId`/`room_id`/`id`, read its definition in `supabase/migrations/20260706000002_rpcs.sql` and use the actual key rather than guessing.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260805000002_xtina_deal.sql scripts/smoke-xtina.mjs
git commit -m "feat(db): script the xtina bunch, deal, and peel sequence"
```

---

## Task 4: Worker gateway

Four small edits. Each one is a branch on `rooms.mode`, so an ordinary game is bit-for-bit unaffected.

**Files:**
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Consumes: `set_xtina_enabled` from Task 2; `rooms.mode = 'xtina'` from Task 3.
- Produces: `POST /profile/xtina` accepting `{ enabled: boolean }` and returning `{ ok: true, enabled: boolean }`; `POST /rooms/:roomId/dump` returning 400 `XTINA_NO_DUMP` in xtina rooms.

- [ ] **Step 1: Add a mode lookup helper**

Near the other module-level helpers in `apps/api/src/index.ts`, add:

```ts
/** A room's mode, for the handful of routes that must behave differently in xtina mode.
 * Returns null when the room is missing — callers treat that as "not xtina" and let the RPC
 * below them raise the real ROOM_NOT_FOUND. */
async function roomMode(
  admin: ReturnType<typeof createAdminClient>,
  roomId: string,
): Promise<string | null> {
  const { data } = await admin.from('rooms').select('mode').eq('id', roomId).single();
  return (data as { mode?: string } | null)?.mode ?? null;
}
```

- [ ] **Step 2: Block Dump in xtina rooms**

In `app.post('/rooms/:roomId/dump', ...)`, insert immediately after `const admin = createAdminClient(c.env);`:

```ts
  // Dump draws three tiles from the shared Bunch, which would desynchronize the scripted deal
  // and leave the endgame arithmetic unable to land on zero. The client hides the button too;
  // this is the authoritative half.
  if ((await roomMode(admin, roomId)) === 'xtina') {
    return c.json({ error: 'XTINA_NO_DUMP' }, 400);
  }
```

- [ ] **Step 3: Skip the dictionary check for xtina Plantains**

In `app.post('/rooms/:roomId/plantains', ...)`, replace the block that begins
`const { data: invalidWords, error: dictError } = await admin.rpc('find_invalid_words', {` and ends
with the `return c.json({ error: 'INVALID_WORDS', invalidWords }, 400);` closing brace with:

```ts
  // The xtina board is scripted end to end, so there is nothing to cheat — and one of its words
  // ("YOURE") is deliberately not in Collins/SOWPODS. Skipping the lookup here is what lets it
  // through; structural validation above still runs in full. An earlier design added YOURE to an
  // official word set instead, which was wrong: official sets are world-readable via
  // official_word_sets, so it would have appeared in the partner's Dictionary journal as a fake
  // language.
  if ((await roomMode(admin, roomId)) !== 'xtina') {
    const { data: invalidWords, error: dictError } = await admin.rpc('find_invalid_words', {
      p_room_id: roomId,
      p_words: structural.words,
    });
    if (dictError) return c.json({ error: dictError.message }, statusForRpcError(dictError.message));

    if (invalidWords && invalidWords.length > 0) {
      await admin.rpc('append_room_event', {
        p_room_id: roomId,
        p_type: 'plantains_rejected',
        p_payload: { actor: profileId, reason: 'INVALID_WORDS', invalidWords },
      });
      return c.json({ error: 'INVALID_WORDS', invalidWords }, 400);
    }
  }
```

- [ ] **Step 4: Skip the client summary for xtina rooms**

In `app.post('/rooms/:roomId/summary', ...)`, insert right after the admin client is created:

```ts
  // An xtina game is not a real game: it must not touch lifetime stats, the daily streak, or
  // achievements. archive_game already early-returns for the server-side half; this is the
  // client-submitted half.
  if ((await roomMode(admin, roomId)) === 'xtina') {
    return c.json({ ok: true, longestWord: null, rarestWord: null, wordCount: 0 });
  }
```

- [ ] **Step 5: Add the toggle route**

Next to the other `/profile` routes:

```ts
app.post('/profile/xtina', async (c) => {
  const profileId = c.get('profileId');
  const body = await c.req.json<{ enabled: boolean }>();
  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('set_xtina_enabled', {
    p_profile: profileId,
    p_on: Boolean(body.enabled),
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});
```

- [ ] **Step 6: Typecheck the Worker**

```bash
npm run build --workspace apps/api
```

Expected: no TypeScript errors. If `apps/api` has no `build` script, run `npx tsc --noEmit -p apps/api`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat(api): gate dump, dictionary check, and stats on xtina mode"
```

---

## Task 5: Client profile plumbing and the toggle

The on/off button. Only the owner account ever renders it.

**Files:**
- Modify: `apps/web/src/lib/profile.ts`
- Modify: `apps/web/src/store/sessionStore.ts`
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/components/XtinaToggle.tsx`
- Modify: `apps/web/src/pages/Profile.tsx`

**Interfaces:**
- Consumes: `POST /profile/xtina` from Task 4; `profiles.xtina_role`/`xtina_enabled` from Task 2.
- Produces: `useSessionStore` fields `xtinaRole: 'owner' | 'partner' | null` and `xtinaEnabled: boolean`; `api.setXtinaEnabled(enabled)`.

- [ ] **Step 1: Widen the profile row type**

In `apps/web/src/lib/profile.ts`, add to `interface ProfileRow`:

```ts
  /** 'owner' may arm xtina mode; 'partner' is the account its scripted deal targets.
   * Null for every ordinary account, which is everyone. */
  xtina_role: 'owner' | 'partner' | null;
  /** Whether xtina mode is armed. Only meaningful on an owner row. */
  xtina_enabled: boolean;
```

If `fetchMyProfile` selects an explicit column list rather than `*`, add `xtina_role` and `xtina_enabled` to it.

- [ ] **Step 2: Hold them in the session store**

In `apps/web/src/store/sessionStore.ts`, add to `interface SessionState`:

```ts
  xtinaRole: 'owner' | 'partner' | null;
  xtinaEnabled: boolean;
  setXtinaEnabled: (enabled: boolean) => void;
```

Add to the store's initial values:

```ts
  xtinaRole: null,
  xtinaEnabled: false,
  setXtinaEnabled: (xtinaEnabled) => set({ xtinaEnabled }),
```

And inside `hydrateProfile`, extend the final `set({ ... })` call with:

```ts
      xtinaRole: profile.xtina_role ?? null,
      xtinaEnabled: profile.xtina_enabled ?? false,
```

- [ ] **Step 3: Add the API method**

In `apps/web/src/lib/api.ts`, add to the `api` object:

```ts
  setXtinaEnabled: (enabled: boolean) =>
    call<{ ok: true; enabled: boolean }>('/profile/xtina', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
```

- [ ] **Step 4: Build the toggle**

Create `apps/web/src/components/XtinaToggle.tsx`:

```tsx
import { useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { useSessionStore } from '../store/sessionStore.js';

/**
 * The xtina mode on/off button. Renders nothing at all unless this account carries the 'owner'
 * role, so for every other player — including the partner — it does not exist in the DOM.
 * The server re-checks the role in set_xtina_enabled; this is presentation only.
 */
export default function XtinaToggle() {
  const xtinaRole = useSessionStore((s) => s.xtinaRole);
  const enabled = useSessionStore((s) => s.xtinaEnabled);
  const setEnabled = useSessionStore((s) => s.setXtinaEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (xtinaRole !== 'owner') return null;

  async function toggle() {
    const next = !enabled;
    setBusy(true);
    setError(null);
    setEnabled(next); // optimistic
    try {
      const res = await api.setXtinaEnabled(next);
      setEnabled(res.enabled);
    } catch (err) {
      setEnabled(!next); // roll back
      setError(err instanceof ApiError ? err.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="profile-section">
      <h3>Xtina mode</h3>
      <p className="profile-hint">
        When this is on, your next two-player game becomes the scripted one.
      </p>
      <button
        type="button"
        className={`btn-secondary${enabled ? ' active' : ''}`}
        aria-pressed={enabled}
        disabled={busy}
        onClick={toggle}
      >
        {enabled ? 'On' : 'Off'}
      </button>
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
```

If `profile-section`, `profile-hint` or `form-error` are not the class names the Overview tab already uses for its other sections, match whatever it actually uses — read `apps/web/src/pages/Profile.tsx` around the display-name and avatar sections and copy those.

- [ ] **Step 5: Mount it**

In `apps/web/src/pages/Profile.tsx`, import it:

```tsx
import XtinaToggle from '../components/XtinaToggle.js';
```

and render `<XtinaToggle />` inside `Overview`'s returned markup, just before the account-deletion section.

- [ ] **Step 6: Verify it renders for nobody by default**

```bash
npm run dev:web
```

Open the app, go to `/profile`, and confirm the Overview tab shows **no** Xtina section (your local account has no role). Then in the Supabase SQL editor for the local stack, run
`update public.profiles set xtina_role = 'owner' where id = '<your local profile id>';`, reload, and confirm the section now appears and the button flips between On and Off and survives a reload.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/profile.ts apps/web/src/store/sessionStore.ts apps/web/src/lib/api.ts apps/web/src/components/XtinaToggle.tsx apps/web/src/pages/Profile.tsx
git commit -m "feat(web): add the owner-only xtina mode toggle"
```

---

## Task 6: Board hint and accent rendering

Two new presentational props on `GameBoard`, plus their CSS. No behavior — this task alone changes nothing visible, because nothing passes the props yet.

**Files:**
- Modify: `apps/web/src/components/GameBoard.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: nothing.
- Produces: `GameBoard` props `hintCells: Set<string>` and `accentCells: Set<string>`; CSS classes `.board-hint` and `.board-tile.accent`.

- [ ] **Step 1: Add the props**

In `apps/web/src/components/GameBoard.tsx`, add to `interface Props`:

```ts
  /** Empty cells to outline in dotted lines — where the next scripted word goes. Deliberately
   * carries no letters: working the word out from the tiles in the tray is the point. */
  hintCells: Set<string>;
  /** Cells rendered in the accent color instead of the ordinary tile color. Takes precedence
   * over `validCells`, so an accented word never reads as an invalid one. */
  accentCells: Set<string>;
```

Add both to the destructured parameter list alongside `validCells`.

- [ ] **Step 2: Render the hints**

Inside the `.board-world` div, **before** the `{Object.entries(grid).map(...)}` block so hints paint underneath any tile:

```tsx
        {[...hintCells].map((key) => {
          const { x, y } = parseKey(key);
          return (
            <div
              key={`hint-${key}`}
              className="board-hint"
              style={{ left: x * CELL, top: y * CELL, width: CELL, height: CELL }}
            />
          );
        })}
```

- [ ] **Step 3: Apply the accent class**

In the tile `className` template, add an accent segment. Replace:

```tsx
              className={`board-tile${validCells.has(key) ? ' valid' : ''}${selected ? ' selected' : ''}`}
```

with:

```tsx
              className={`board-tile${accentCells.has(key) ? ' accent' : validCells.has(key) ? ' valid' : ''}${selected ? ' selected' : ''}`}
```

- [ ] **Step 4: Add the CSS**

In `apps/web/src/styles.css`, after the `.board-tile.valid` rule:

```css
/* Xtina mode: where the next word goes. An outline on an EMPTY cell, never a letter — the
   player works the word out from the tiles in their tray. pointer-events:none so it can't
   swallow a pointerdown that belongs to the board's drag system. */
.board-hint {
  position: absolute;
  border: 2px dashed var(--color-accent);
  border-radius: 8px;
  background: rgba(255, 159, 67, 0.1);
  pointer-events: none;
  z-index: 0;
}

@media (prefers-reduced-motion: no-preference) {
  .board-hint {
    animation: hint-pulse 1.8s ease-in-out infinite;
  }
}

@keyframes hint-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}

/* Xtina mode accent words (YOURE, MY, LOVE). Deliberately overrides .valid rather than
   composing with it: one of these words is not in the dictionary and would otherwise render
   untinted next to nine tinted ones. */
.board-tile.accent {
  background: var(--color-accent);
  border-color: var(--color-accent-shadow);
  color: var(--color-text-on-accent);
}
```

Confirm `--color-accent-shadow` exists in `apps/web/src/styles/tokens.css`; it is referenced by `.board-tile.selected`, so it should. If it does not, use `--color-accent` for the border too.

- [ ] **Step 5: Pass empty sets from the one existing call site so the build stays green**

In `apps/web/src/pages/Game.tsx`, add to the `<GameBoard ... />` props:

```tsx
          hintCells={EMPTY_CELLS}
          accentCells={EMPTY_CELLS}
```

and define near the other module constants at the top of the file:

```tsx
/** Stable empty set — a fresh `new Set()` per render would defeat GameBoard's reconciliation. */
const EMPTY_CELLS: Set<string> = new Set();
```

- [ ] **Step 6: Typecheck**

```bash
npm run build --workspace apps/web
```

Expected: no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/GameBoard.tsx apps/web/src/styles.css apps/web/src/pages/Game.tsx
git commit -m "feat(web): add dotted hint and accent tile rendering to the board"
```

---

## Task 7: Game screen wiring

Where the mode becomes real: hints appear, the soft gate holds the script to the picture, Dump disappears, and the finished board is held on screen.

**Files:**
- Modify: `apps/web/src/lib/rooms.ts`
- Modify: `apps/web/src/pages/Game.tsx`

**Interfaces:**
- Consumes: `xtinaHintCells`, `xtinaAccentCells`, `xtinaGridMatches`, `XTINA_STEPS` from Task 1; `GameBoard`'s `hintCells`/`accentCells` from Task 6; `rooms.mode_config` from Task 3.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Widen the room type**

In `apps/web/src/lib/rooms.ts`, change `PublicRoom`:

```ts
  mode: 'multiplayer' | 'solo' | 'xtina';
  mode_config: SoloModeConfig | XtinaModeConfig | Record<string, never>;
```

and add above the interface:

```ts
/** rooms.mode_config for an xtina room. `step` is how many of the ten words have been dealt. */
export interface XtinaModeConfig {
  partnerId: string;
  step: number;
}
```

- [ ] **Step 2: Derive the mode state in Game.tsx**

Add to the imports from `@plantain/shared`:

```ts
  XTINA_STEPS,
  xtinaAccentCells,
  xtinaGridMatches,
  xtinaHintCells,
```

and to the `../lib/rooms.js` import, `type XtinaModeConfig`.

Then, near the existing `const isSolo = room?.mode === 'solo';`, add:

```tsx
  // --- Xtina mode ------------------------------------------------------------
  // Everything here is presentation over an otherwise ordinary game: the server already dealt
  // the scripted tiles, and the board, tray and drag system are untouched. Only the partner
  // sees hints — the owner is playing a real (unwinnable) game.
  const xtinaConfig = room?.mode === 'xtina' ? (room.mode_config as XtinaModeConfig) : null;
  const isXtina = xtinaConfig !== null;
  const isXtinaPartner = isXtina && xtinaConfig.partnerId === profileId;
  const xtinaStep = xtinaConfig?.step ?? 0;

  // Hints are for the word whose tiles are in the tray RIGHT NOW (step), not the next one.
  // They vanish once those cells are filled, so a correctly-placed word leaves a clean board
  // until the peel lands and the next set appears.
  const xtinaHints = useMemo(() => {
    if (!isXtinaPartner || xtinaStep < 1 || xtinaStep > XTINA_STEPS) return EMPTY_CELLS;
    const pending = [...xtinaHintCells(xtinaStep)].filter((k) => !(k in grid));
    return pending.length > 0 ? new Set(pending) : EMPTY_CELLS;
  }, [isXtinaPartner, xtinaStep, grid]);

  const xtinaAccents = useMemo(
    () => (isXtinaPartner ? xtinaAccentCells() : EMPTY_CELLS),
    [isXtinaPartner],
  );
```

Add `useMemo` to the `react` import if it is not already there.

- [ ] **Step 3: Gate the auto-action on the target grid**

In the `useEffect` that ends with `runAutoAction()`, insert immediately **before** the `const sig = ...` line:

```tsx
    // The soft gate. Her rack holds exactly one word's tiles, so a structurally valid grid is
    // nearly always the right word — but it could be the right letters in the wrong place, which
    // would peel the script forward onto a board that no longer matches the picture. Requiring an
    // exact match means a wrong placement simply doesn't advance: no error, no rejected drag, no
    // visible fight with the player.
    if (isXtinaPartner && !xtinaGridMatches(grid, xtinaStep)) {
      autoSigRef.current = null;
      return;
    }
```

Add `isXtinaPartner` and `xtinaStep` to that effect's dependency array.

- [ ] **Step 4: Hold the finished board instead of navigating**

Add state near the other `useState` calls:

```tsx
  const [xtinaFinished, setXtinaFinished] = useState(false);
```

In `runAutoAction`'s Plantains branch, replace:

```tsx
        await api.plantains(roomId, submittedGrid);
        submitSummaryOnce();
        fireCallout('PLANTAINS!');
        setTimeout(() => navigate(`/room/${roomId}/results`, { replace: true }), CALLOUT_MS);
```

with:

```tsx
        await api.plantains(roomId, submittedGrid);
        submitSummaryOnce();
        fireCallout('PLANTAINS!');
        if (isXtinaPartner) {
          // Hold the completed board on screen rather than yanking her to a scoreboard. The
          // Plantains call already persisted the grid, so the board viewer below has something
          // to show whenever she chooses to open it.
          setXtinaFinished(true);
        } else {
          setTimeout(() => navigate(`/room/${roomId}/results`, { replace: true }), CALLOUT_MS);
        }
```

Add `isXtinaPartner` to `runAutoAction`'s dependency array.

- [ ] **Step 5: Hide Dump, and add the viewer button**

Replace the `<span className="tray-tool-group">` block containing the Dump button with:

```tsx
          {!isXtina && (
            <span className="tray-tool-group">
              <button className="btn-tertiary" disabled={!selectedId} onClick={handleDump}>
                Dump!
              </button>
              <InfoTooltip text="Select a tile in your tray first. Dump returns it to the Bunch face-down and draws you 3 new tiles in exchange." />
            </span>
          )}
```

Then, inside the `board-area` div and after the `zoom-controls` block, add:

```tsx
        {xtinaFinished && (
          <button
            type="button"
            className="btn-primary xtina-view-board"
            onClick={() => navigate(`/room/${roomId}/boards`)}
          >
            View the board
          </button>
        )}
```

and in `styles.css`:

```css
/* Sits over the held board once the xtina game completes. Positioned rather than in flow so it
   can't reflow the board underneath it at the moment the player is looking at it. */
.xtina-view-board {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  z-index: 3;
}
```

- [ ] **Step 6: Pass the real sets to GameBoard**

Replace the placeholder props added in Task 6 Step 5:

```tsx
          hintCells={xtinaHints}
          accentCells={xtinaAccents}
```

- [ ] **Step 7: Typecheck and play it through**

```bash
npm run build --workspace apps/web
```

Then, with two browser profiles signed in as the local owner and partner accounts (roles set by SQL as in Task 5 Step 6, and the toggle On):

1. Owner creates a room; partner joins; owner Splits.
2. Confirm the partner's tray holds `Y O U R E`, five dotted outlines appear at (18,22)–(22,22), and the owner's tray is all `X`/`Z`.
3. Place `YOURE` **wrong** — one cell to the right. Confirm nothing happens: no peel, no error.
4. Place it on the outlines. Confirm a Peel fires, `BEAUTIFUL`'s eight tiles arrive, and eight new outlines appear.
5. Confirm the Dump button is absent for both players.
6. Play through all ten words. Confirm `PLANTAINS!` fires, the board stays on screen, `YOURE`/`MY`/`LOVE` render in the accent color, and "View the board" opens the board viewer.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/rooms.ts apps/web/src/pages/Game.tsx apps/web/src/styles.css
git commit -m "feat(web): wire xtina hints, the placement gate, and the held endgame board"
```

---

## Task 8: The Stina avatar

Plumbing only — the artwork is a placeholder to be replaced by hand.

**Files:**
- Modify: `packages/shared/src/avatar.ts`
- Modify: `packages/shared/test/avatar.test.ts`
- Modify: `apps/web/src/components/Avatar.tsx`
- Modify: `apps/web/src/pages/Profile.tsx` — the `AvatarEditor` function at line 289

**Interfaces:**
- Consumes: `useSessionStore().xtinaRole` from Task 5.
- Produces: `'stina'` as a valid `AvatarConfig.base`.

- [ ] **Step 1: Add the option**

In `packages/shared/src/avatar.ts`, change the `base` line of `ACCESSORY_SETS`:

```ts
  base: ['ripe', 'green', 'golden', 'speckled', 'stina'],
```

Validation is data-driven off this table, so `validateAvatarConfig` and `normalizeAvatarConfig` need no change.

- [ ] **Step 2: Prove validation picks it up**

`packages/shared/test/avatar.test.ts` already exists and already imports `validateAvatarConfig` and `normalizeAvatarConfig` from `'../src/index.js'`. Append this `it` block inside its existing top-level `describe`:

```ts
it("accepts 'stina' as a base without any change to the validator", () => {
  expect(validateAvatarConfig({ base: 'stina' })).toEqual({ valid: true });
  expect(normalizeAvatarConfig({ base: 'stina' }).base).toBe('stina');
});
```

- [ ] **Step 3: Run it**

```bash
npm run test:shared
```

Expected: PASS.

- [ ] **Step 4: Render it**

In `apps/web/src/components/Avatar.tsx`, add entries to both records:

```ts
const BODY_FILL: Record<string, string> = {
  // ...existing entries unchanged...
  // PLACEHOLDER — replace with the real Stina design. Distinct enough to be obviously
  // unfinished so it can't ship by accident.
  stina: '#f2a7c3',
};

const BODY_STROKE: Record<string, string> = {
  // ...existing entries unchanged...
  stina: '#b4587a',
};
```

The existing `BODY_FILL[c.base] ?? BODY_FILL.ripe` lookup then handles it with no further change. Anything beyond a recolor — a different body shape, extra SVG paths — goes in a `{c.base === 'stina' && (...)}` block alongside the existing `{c.base === 'speckled' && (...)}` block.

- [ ] **Step 5: Gate the swatch to the partner**

The swatch grid is the `AvatarEditor` function in `apps/web/src/pages/Profile.tsx` (line 289). It is generic over all four slots and maps `ACCESSORY_SETS[slot]` directly, so the filter goes in a helper rather than a `baseOptions` constant. Replace the function's first two lines and its inner `.map` call:

```tsx
function AvatarEditor({ config, onChange }: { config: AvatarConfig; onChange: (c: AvatarConfig) => void }) {
  const current = normalizeAvatarConfig(config);
  const xtinaRole = useSessionStore((s) => s.xtinaRole);
  const slots: AccessorySlot[] = ['base', 'hat', 'glasses', 'hair'];
  // The Stina base is hers alone. Gated on the role rather than on xtinaEnabled deliberately:
  // the avatar shouldn't disappear just because no game happens to be armed.
  const optionsFor = (slot: AccessorySlot): readonly string[] =>
    ACCESSORY_SETS[slot].filter((o) => o !== 'stina' || xtinaRole === 'partner');
```

and inside the slot loop, change:

```tsx
            {ACCESSORY_SETS[slot].map((option) => (
```

to:

```tsx
            {optionsFor(slot).map((option) => (
```

`Profile.tsx` already imports `useSessionStore` (the `Overview` component uses it), so no new import is needed.

- [ ] **Step 6: Verify in the browser**

```bash
npm run dev:web
```

Open `/profile` → edit avatar. With no role set, confirm there are still exactly four base swatches. Set `xtina_role = 'partner'` on your local profile via SQL, reload, and confirm a fifth swatch appears, selects, saves, and survives a reload.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/avatar.ts packages/shared/test/avatar.test.ts apps/web/src/components/Avatar.tsx apps/web/src/pages/Profile.tsx
git commit -m "feat: add the partner-only stina avatar base (placeholder art)"
```

---

## Deployment

Follow the project's normal manual database step — **run the two migrations in filename order, one at a time**, `20260805000001` before `20260805000002`. A skipped migration fails later with a confusing error pointing at the wrong file.

After both are applied to production, assign the roles by hand in the Supabase SQL editor:

```sql
update public.profiles set xtina_role = 'owner'   where id = '<owner profile uuid>';
update public.profiles set xtina_role = 'partner' where id = '<partner profile uuid>';
```

Both accounts must be OAuth-linked first. An anonymous account gets a fresh `auth.users` row every session, so a role set on one evaporates.

`apps/web` and `apps/api` deploy themselves on push to `main`.
