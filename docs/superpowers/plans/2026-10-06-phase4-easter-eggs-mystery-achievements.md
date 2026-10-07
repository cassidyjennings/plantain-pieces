# Phase 4 Easter Eggs + Mystery Achievements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 4 of `docs/superpowers/specs/2026-10-06-polish-solo-batches-easter-eggs-design.md`:
four easter-egg words (MIT, SUPERCALIFRAGILISTICEXPIALIDOCIOUS, GHOST, FREEZE) that are valid in
every dictionary and mode and each carry an effect (maroon tint / instant win / hidden tile count /
10-second clock freeze in Timed solo), plus five hidden "mystery" achievements (egg_hunter,
mind_and_hand, practically_perfect, collector, speedrun) shown as "???" with a hint until unlocked.

**Architecture:** One shared source of truth (`packages/shared/src/easterEggs.ts`) with a SQL twin
(`public._easter_egg_words()`, immutable). `_find_invalid_words_cfg` strips egg words from its
input *before* the unchanged two-EXISTS dictionary query, so `/validate`, Plantains and
`submit_game_summary` all accept eggs at once. Per-room egg state lives on the room
(`room_players.ghosted`, `room_players.freeze_used`, `rooms.win_kind`) so it dies with the room and
is cleared by `rematch_room`. GHOST and FREEZE are reported through the existing
`POST /rooms/:id/progress` route, which calls a new dedicated `report_egg_flags` RPC (no change to
`report_progress`'s signature). Supercali gets its own Worker route + `supercali_win` RPC (row lock,
sub-multiset/connectivity/word-presence re-checked in SQL, bunch-low gate bypassed). The client
detects eggs with a `useEasterEggs` hook that fires each trigger once per game. Egg discovery is
reported in the end-of-game summary (`eggs_found`, inside the existing `p_summary` jsonb) and
accumulated in `profiles.eggs_found` (self-read only). Mystery achievements are flagged
`hidden: true` in `achievements.ts`.

**Tech Stack:** Supabase Postgres (plpgsql SECURITY DEFINER RPCs, views, RLS), Cloudflare Worker
(Hono), React 18 + TypeScript (Vite), Zustand, vitest (`packages/shared`), `pg` (Node) smoke scripts.

## Global Constraints

- Phase 4 is built AFTER Phases 1-3 of the same spec have landed; line numbers below are from the pre-Phase-1 tree, so locate every edit by the quoted anchor text, not the line number.
- Every mutation goes through a `SECURITY DEFINER` RPC that takes `select ... for update` on the `rooms` row before touching game state.
- `create or replace` keeps the EXACT existing signature; never add a parameter to an existing RPC (overload risk) — put new data in an existing jsonb param or add a dedicated new RPC.
- Every new function gets `revoke all ... from public, anon, authenticated` + `grant execute ... to service_role` in a `do $$` block.
- Clients never call action RPCs directly; the Worker validates, then calls the RPC.
- `_find_invalid_words_cfg`'s two separate EXISTS blocks and the length bounds INSIDE the negation are load-bearing for index use; the egg short-circuit is a separate pre-filter, never OR'd in.
- `profiles` is self-read only (`profiles_select_own`); `profiles.eggs_found` must NOT be added to `profiles_public`.
- `room_players_public` must keep `security_invoker = false` and only ever append columns (replace-safe pattern).
- Opponent grids are never sent during play; GHOST only hides counts, it never reveals anything.
- The 4 egg words are defined in BOTH `easterEggs.ts` and `_easter_egg_words()` — same words, same order; the smoke test asserts this.
- `_archive_game_impl` / `submit_game_summary` / `rematch_room` bodies are reproduced IN FULL from their latest definitions; if a Phase 1-3 migration redefined one of them, re-copy that newer body and re-apply only the `-- [phase4]` deltas.
- Migrations run locally in filename order (`npx supabase migration up --local`) and pass the smoke script before any prod handoff; prod migrations are pasted from the FILE into the dashboard SQL editor, one at a time, in order.
- Verification honesty: typecheck/build passing is never cited as proof a runtime behavior works; say plainly what was and was not verified live.
- Uses npm workspaces (never pnpm). Shell is Windows (PowerShell / Git Bash); prefer absolute paths; use `$env:VAR = '...'` on its own line in PowerShell.
- Any button with a visible "on" state uses `.toggle-btn` (none are added by this plan).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Shared egg module `packages/shared/src/easterEggs.ts`

**Files:**
- Create: `packages/shared/src/easterEggs.ts`
- Create: `packages/shared/test/easterEggs.test.ts`
- Modify: `packages/shared/src/index.ts:11` (append export)

**Interfaces:**
```ts
export const EASTER_EGG_WORDS: readonly ['MIT', 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS', 'GHOST', 'FREEZE'];
export type EggWord = (typeof EASTER_EGG_WORDS)[number];
export const SUPERCALI: 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS';
export const FREEZE_DURATION_MS: 10000;
export type EggEffect = 'tint' | 'instant_win' | 'ghost' | 'freeze';
export interface EasterEggDef { effect: EggEffect; description: string }
export const EASTER_EGGS: Record<EggWord, EasterEggDef>;
export function isEasterEggWord(word: string): word is EggWord;            // strict uppercase
export function eggWordsIn(words: Iterable<string>): EggWord[];            // canonical order, deduped
export function newlyFoundEggs(present: Iterable<string>, fired: ReadonlySet<string>): EggWord[];
export function isSubMultiset(sub: Record<string, number>, sup: Record<string, number>): boolean;
export type SupercaliInvalidReason = 'EMPTY_GRID' | 'EXTRA_TILES' | 'NOT_CONNECTED' | 'ORPHAN_TILE' | 'NO_SUPERCALI';
export interface SupercaliResult { valid: boolean; reason?: SupercaliInvalidReason; words: string[]; orphans: string[] }
export function validateSupercaliStructure(grid: GridState, rack: Letter[]): SupercaliResult;
export function sanitizeEggsFound(input: unknown): EggWord[] | null;      // null = malformed
```

- [ ] **Step 1: Write the failing test** — create `packages/shared/test/easterEggs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  EASTER_EGG_WORDS,
  EASTER_EGGS,
  SUPERCALI,
  FREEZE_DURATION_MS,
  isEasterEggWord,
  eggWordsIn,
  newlyFoundEggs,
  isSubMultiset,
  validateSupercaliStructure,
  sanitizeEggsFound,
  makeKey,
  type GridState,
} from '../src/index.js';

/** A horizontal run of `word` starting at (x0, y). */
function row(word: string, x0: number, y: number): GridState {
  const g: GridState = {};
  [...word].forEach((l, i) => {
    g[makeKey(x0 + i, y)] = l;
  });
  return g;
}

describe('egg word list', () => {
  it('is exactly the four spec words, in the order the SQL twin uses', () => {
    expect([...EASTER_EGG_WORDS]).toEqual(['MIT', 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS', 'GHOST', 'FREEZE']);
  });

  it('has metadata for every word', () => {
    for (const w of EASTER_EGG_WORDS) expect(EASTER_EGGS[w].description.length).toBeGreaterThan(0);
    expect(EASTER_EGGS.MIT.effect).toBe('tint');
    expect(EASTER_EGGS[SUPERCALI].effect).toBe('instant_win');
    expect(EASTER_EGGS.GHOST.effect).toBe('ghost');
    expect(EASTER_EGGS.FREEZE.effect).toBe('freeze');
  });

  it('SUPERCALI is 34 letters and fits the 50-wide grid', () => {
    expect(SUPERCALI).toHaveLength(34);
    expect(SUPERCALI.length).toBeLessThan(50);
  });

  it('freezes for exactly 10 seconds (archive_game subtracts the same 10000)', () => {
    expect(FREEZE_DURATION_MS).toBe(10_000);
  });
});

describe('isEasterEggWord / eggWordsIn', () => {
  it('matches uppercase egg words only', () => {
    expect(isEasterEggWord('MIT')).toBe(true);
    expect(isEasterEggWord('GHOST')).toBe(true);
    expect(isEasterEggWord('mit')).toBe(false);
    expect(isEasterEggWord('MITT')).toBe(false);
  });

  it('extracts eggs from a word list in canonical order, deduped', () => {
    expect(eggWordsIn(['CAT', 'FREEZE', 'MIT', 'FREEZE', 'DOG'])).toEqual(['MIT', 'FREEZE']);
    expect(eggWordsIn(['CAT', 'DOG'])).toEqual([]);
  });
});

describe('newlyFoundEggs (trigger-once support)', () => {
  it('returns eggs present but not yet fired', () => {
    expect(newlyFoundEggs(['GHOST', 'MIT', 'CAT'], new Set())).toEqual(['MIT', 'GHOST']);
  });
  it('skips eggs that already fired', () => {
    expect(newlyFoundEggs(['GHOST', 'MIT'], new Set(['MIT']))).toEqual(['GHOST']);
    expect(newlyFoundEggs(['MIT'], new Set(['MIT']))).toEqual([]);
  });
});

describe('isSubMultiset', () => {
  it('accepts equal and smaller multisets', () => {
    expect(isSubMultiset({ A: 1 }, { A: 1 })).toBe(true);
    expect(isSubMultiset({ A: 1 }, { A: 2, B: 1 })).toBe(true);
    expect(isSubMultiset({}, { A: 1 })).toBe(true);
  });
  it('rejects a surplus of any letter, even when another letter is short', () => {
    expect(isSubMultiset({ A: 2 }, { A: 1, B: 5 })).toBe(false);
    expect(isSubMultiset({ Z: 1 }, { A: 1 })).toBe(false);
  });
});

describe('validateSupercaliStructure', () => {
  const wordGrid = row(SUPERCALI, 5, 10);
  const exactRack = [...SUPERCALI];

  it('accepts the word with extra tiles still in hand (sub-multiset, not equality)', () => {
    const r = validateSupercaliStructure(wordGrid, [...exactRack, 'Q', 'I']);
    expect(r.valid).toBe(true);
    expect(r.words).toEqual([SUPERCALI]);
  });

  it('rejects an empty grid', () => {
    expect(validateSupercaliStructure({}, exactRack)).toMatchObject({ valid: false, reason: 'EMPTY_GRID' });
  });

  it('rejects letters the player does not own', () => {
    expect(validateSupercaliStructure(wordGrid, exactRack.slice(1))).toMatchObject({
      valid: false,
      reason: 'EXTRA_TILES',
    });
  });

  it('rejects a disconnected grid', () => {
    const g = { ...wordGrid, ...row('QI', 5, 20) };
    expect(validateSupercaliStructure(g, [...exactRack, 'Q', 'I'])).toMatchObject({
      valid: false,
      reason: 'NOT_CONNECTED',
    });
  });

  it('rejects a single orphan tile', () => {
    expect(validateSupercaliStructure({ [makeKey(1, 1)]: 'S' }, exactRack)).toMatchObject({
      valid: false,
      reason: 'ORPHAN_TILE',
    });
  });

  it('rejects a grid that does not contain the word', () => {
    expect(validateSupercaliStructure(row('QI', 5, 20), ['Q', 'I'])).toMatchObject({
      valid: false,
      reason: 'NO_SUPERCALI',
    });
  });

  it('rejects the word embedded in a longer run', () => {
    const g = { ...wordGrid, [makeKey(39, 10)]: 'I' };
    expect(validateSupercaliStructure(g, [...exactRack, 'I'])).toMatchObject({
      valid: false,
      reason: 'NO_SUPERCALI',
    });
  });
});

describe('sanitizeEggsFound', () => {
  it('uppercases and dedupes a valid list into canonical order', () => {
    expect(sanitizeEggsFound(['ghost', 'MIT', 'GHOST'])).toEqual(['MIT', 'GHOST']);
    expect(sanitizeEggsFound([])).toEqual([]);
  });
  it('returns null for a non-array, a non-string, a non-egg, or an absurd length', () => {
    expect(sanitizeEggsFound('MIT')).toBeNull();
    expect(sanitizeEggsFound([42])).toBeNull();
    expect(sanitizeEggsFound(['MIT', 'NOTANEGG'])).toBeNull();
    expect(sanitizeEggsFound(new Array(50).fill('MIT'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --root packages/shared easterEggs`
Expected: FAIL — `SyntaxError: The requested module '../src/index.js' does not provide an export named 'EASTER_EGG_WORDS'` (or equivalent "is not exported" error).

- [ ] **Step 3: Write the module** — create `packages/shared/src/easterEggs.ts`:

```ts
/** Easter-egg words — the single source of truth for the client and the Worker.
 *
 * Every word here is ALWAYS valid, in every dictionary and every mode, regardless of the room's
 * dictionary config or length bounds. The SQL twin is `public._easter_egg_words()` (migration
 * 20261006000401) — keep the two lists identical, same order, exactly like the tile distribution
 * is kept in sync between tiles.ts and `_fresh_bunch()`. scripts/smoke-easter-eggs.mjs asserts it.
 *
 * Shipping this list in the public bundle is deliberate: these spread by word of mouth. */
import type { GridState, Letter } from './types.js';
import { extractWords, findOrphans, gridLetters, isConnected, letterMultiset } from './grid.js';

export const EASTER_EGG_WORDS = ['MIT', 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS', 'GHOST', 'FREEZE'] as const;

export type EggWord = (typeof EASTER_EGG_WORDS)[number];

export const SUPERCALI = 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS' as const;

/** How long FREEZE stops the Timed solo clock. `_archive_game_impl` subtracts the same 10000. */
export const FREEZE_DURATION_MS = 10_000 as const;

export type EggEffect = 'tint' | 'instant_win' | 'ghost' | 'freeze';

export interface EasterEggDef {
  effect: EggEffect;
  description: string;
}

export const EASTER_EGGS: Record<EggWord, EasterEggDef> = {
  MIT: { effect: 'tint', description: 'Its tiles turn maroon instead of green.' },
  SUPERCALIFRAGILISTICEXPIALIDOCIOUS: {
    effect: 'instant_win',
    description: 'Validly on your board, it wins the game on the spot.',
  },
  GHOST: { effect: 'ghost', description: 'Opponents see your tile count as ?? for the rest of the game.' },
  FREEZE: { effect: 'freeze', description: 'Timed solo only: the clock stops for 10 seconds, once per game.' },
};

const EGG_SET: ReadonlySet<string> = new Set(EASTER_EGG_WORDS);

/** Strict: grid words are always uppercase (extractWords), so lowercase never matches here. */
export function isEasterEggWord(word: string): word is EggWord {
  return EGG_SET.has(word);
}

/** The egg words in `words`, deduped, in EASTER_EGG_WORDS order. */
export function eggWordsIn(words: Iterable<string>): EggWord[] {
  const present = new Set(words);
  return EASTER_EGG_WORDS.filter((w) => present.has(w));
}

/** Eggs in `present` that have not fired yet — the pure core of useEasterEggs' trigger-once rule. */
export function newlyFoundEggs(present: Iterable<string>, fired: ReadonlySet<string>): EggWord[] {
  return eggWordsIn(present).filter((w) => !fired.has(w));
}

/** Every letter of `sub` appears in `sup` at least as many times. Compared per letter, never by
 * summing (the same trap grid.ts's multisetsEqual documents). */
export function isSubMultiset(sub: Record<string, number>, sup: Record<string, number>): boolean {
  for (const [letter, n] of Object.entries(sub)) {
    if (n > (sup[letter] ?? 0)) return false;
  }
  return true;
}

export type SupercaliInvalidReason = 'EMPTY_GRID' | 'EXTRA_TILES' | 'NOT_CONNECTED' | 'ORPHAN_TILE' | 'NO_SUPERCALI';

export interface SupercaliResult {
  valid: boolean;
  reason?: SupercaliInvalidReason;
  words: string[];
  orphans: string[];
}

/**
 * Structural check for a Supercali win. Same as validateStructure except the grid's letters need
 * only be a SUB-multiset of the rack (other tiles may still be in hand), and the grid must contain
 * SUPERCALI as a whole word (a maximal run). Dictionary validity of the other words is checked
 * separately by the caller (Worker → find_invalid_words).
 */
export function validateSupercaliStructure(grid: GridState, rack: Letter[]): SupercaliResult {
  const words = extractWords(grid);
  const orphans = findOrphans(grid);
  if (Object.keys(grid).length === 0) return { valid: false, reason: 'EMPTY_GRID', words, orphans };
  if (!isSubMultiset(gridLetters(grid), letterMultiset(rack))) {
    return { valid: false, reason: 'EXTRA_TILES', words, orphans };
  }
  if (!isConnected(grid)) return { valid: false, reason: 'NOT_CONNECTED', words, orphans };
  if (orphans.length > 0) return { valid: false, reason: 'ORPHAN_TILE', words, orphans };
  if (!words.includes(SUPERCALI)) return { valid: false, reason: 'NO_SUPERCALI', words, orphans };
  return { valid: true, words, orphans };
}

/** Upper bound on a submitted eggs_found list: generous headroom for future eggs, rejects garbage. */
const MAX_EGGS_FOUND = 32;

/** Validates a client-reported `eggs_found` list. Returns the canonical (uppercased, deduped,
 * EASTER_EGG_WORDS-ordered) list, or null if the payload is malformed or names a non-egg. */
export function sanitizeEggsFound(input: unknown): EggWord[] | null {
  if (!Array.isArray(input) || input.length > MAX_EGGS_FOUND) return null;
  const upper: string[] = [];
  for (const e of input) {
    if (typeof e !== 'string') return null;
    const u = e.toUpperCase();
    if (!isEasterEggWord(u)) return null;
    upper.push(u);
  }
  return eggWordsIn(upper);
}
```

Append to `packages/shared/src/index.ts` (after `export * from './xtina.js';`):

```ts
export * from './easterEggs.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --root packages/shared easterEggs` → Expected: all `easterEggs.test.ts` tests PASS.
Run: `npm run test:shared` → Expected: whole suite PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/easterEggs.ts packages/shared/test/easterEggs.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): easter egg word list, supercali structural check, trigger-once helper

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: SQL egg acceptance — `_easter_egg_words()` + `_find_invalid_words_cfg` short-circuit

**Files:**
- Create: `supabase/migrations/20261006000401_easter_egg_words.sql` (before creating, `ls supabase/migrations | tail -3`; if any Phase 1-3 migration sorts after `20261006000401`, renumber this and every later Phase 4 migration so they sort last, keeping their relative order)
- Create: `scripts/smoke-easter-eggs.mjs`
- Latest definition being replaced: `supabase/migrations/20260728000002_valid_words_only_in_summary.sql:23-66` (`_find_invalid_words_cfg`). `find_invalid_words` (same file :72-87) is a thin wrapper and is NOT redefined.

**Interfaces:**
```sql
public._easter_egg_words() returns text[]   -- immutable, ['MIT','SUPERCALIFRAGILISTICEXPIALIDOCIOUS','GHOST','FREEZE']
public._find_invalid_words_cfg(p_cfg jsonb, p_words text[]) returns text[]   -- unchanged signature
```
Smoke script helpers later tasks reuse: `assert`, `expectError(promise, code, label)`, `makeUser(tag)`,
`q(sql, params)`, `one(sql, params)`, `startedRoom(hostTag, guestTag)` → `{ roomId, code, host, guest }`,
`asUser(uid, sql, params)` → rows, `rowGrid(word, x0, y)`, `hasAchievement(uid, type)`, and the
`SECTIONS` array (each later task adds one `async function sectionX()` above `const SECTIONS` and
appends its name to the array).

- [ ] **Step 1: Write the failing smoke test** — create `scripts/smoke-easter-eggs.mjs`:

```js
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
  return row.id;
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
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run db:start` (no-op if already up), then `npm run build:shared`, then `node scripts/smoke-easter-eggs.mjs`
Expected: FAIL — `function public._easter_egg_words() does not exist`.

- [ ] **Step 3: Write the migration** — create `supabase/migrations/20261006000401_easter_egg_words.sql`:

```sql
-- Phase 4 easter eggs: egg words are ALWAYS valid, in every dictionary and every mode, regardless
-- of the room's dictionary_config or length bounds.
--
-- _easter_egg_words() is the SQL twin of packages/shared/src/easterEggs.ts EASTER_EGG_WORDS —
-- same words, same order (scripts/smoke-easter-eggs.mjs asserts it). Keep them in sync.
--
-- _find_invalid_words_cfg strips egg words out of its input BEFORE the dictionary query. That is a
-- separate pre-filter on purpose: the dictionary query's two separate EXISTS blocks (one per
-- partial index) and its length bounds INSIDE the negation are carried over verbatim — OR-ing an
-- egg test into that WHERE is exactly the kind of change that once turned this into a 2.3-second
-- seq scan (see 20260727000003's header). Because this helper backs find_invalid_words (/validate
-- and Plantains) and submit_game_summary, eggs are accepted everywhere at once.

create or replace function public._easter_egg_words()
returns text[]
language sql
immutable
parallel safe
set search_path = public
as $$
  select array['MIT', 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS', 'GHOST', 'FREEZE']::text[]
$$;

create or replace function public._find_invalid_words_cfg(p_cfg jsonb, p_words text[])
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  cfg jsonb := coalesce(p_cfg, '{}'::jsonb);
  min_len int;
  max_len int;
  base_enabled boolean;
  custom_ids uuid[];
  invalid text[];
  v_candidates text[];  -- [phase4]
begin
  min_len := coalesce((cfg ->> 'minLength')::int, 2);
  max_len := nullif(cfg ->> 'maxLength', 'null')::int;
  base_enabled := coalesce((cfg ->> 'baseEnabled')::boolean, true);
  select coalesce(array_agg(value::uuid), '{}')
    into custom_ids
    from jsonb_array_elements_text(coalesce(cfg -> 'customSetIds', '[]'::jsonb));

  -- [phase4] Egg short-circuit: egg words never reach the dictionary query at all.
  select coalesce(array_agg(w), '{}')
    into v_candidates
  from unnest(p_words) as w
  where not (upper(w) = any (public._easter_egg_words()));

  select coalesce(array_agg(w), '{}')
    into invalid
  from unnest(v_candidates) as w
  where not (
    char_length(w) >= min_len
    and (max_len is null or char_length(w) <= max_len)
    and (
      (base_enabled and exists (
        select 1 from public.words dw
        where dw.word = w::citext and dw.custom_set_id is null
      ))
      or exists (
        select 1 from public.words dw
        where dw.word = w::citext and dw.custom_set_id = any (custom_ids)
      )
    )
  );
  return invalid;
end;
$$;

do $$
begin
  execute 'revoke all on function public._easter_egg_words() from public, anon, authenticated';
  execute 'grant execute on function public._easter_egg_words() to service_role';
  execute 'revoke all on function public._find_invalid_words_cfg(jsonb,text[]) from public, anon, authenticated';
  execute 'grant execute on function public._find_invalid_words_cfg(jsonb,text[]) to service_role';
end $$;
```

- [ ] **Step 4: Apply and run the smoke test to verify it passes**

Run: `npx supabase migration up --local` → Expected: `Applying migration 20261006000401_easter_egg_words.sql...` with no error.
Run: `node scripts/smoke-easter-eggs.mjs` → Expected: 7 `ok` lines under `sectionEggValidation`, then `ALL PASSED`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261006000401_easter_egg_words.sql scripts/smoke-easter-eggs.mjs
git commit -m "feat(db): easter egg words always valid via _find_invalid_words_cfg pre-filter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Client egg verdicts + MIT maroon tint (game board, viewer, Results preview)

**Files:**
- Modify: `apps/web/src/styles/tokens.css:55-57` (new tokens after `--color-tile-valid-border`)
- Modify: `apps/web/src/styles.css:1111` (after `.board-tile.valid`), `:3810-3826` (colorblind overrides)
- Modify: `apps/web/src/components/GameBoard.tsx:5-34` (Props), `:46-62` (destructure), `:103` (className)
- Modify: `apps/web/src/components/BoardPreview.tsx:5-19` (Props), `:33-39`, `:113-116`
- Modify: `apps/web/src/lib/boards.ts:34-41`, `:56-91` (`BoardWords.mitCells`)
- Modify: `apps/web/src/pages/Game.tsx:3-15` (imports), `:259` (`wordVerdictsRef` seed), `:574-577` (new `mitCells` memo after `xtinaAccents`), `:1786-1788` (GameBoard prop)
- Modify: `apps/web/src/pages/BoardViewer.tsx:160-164`
- Modify: `apps/web/src/pages/Results.tsx:101-118` (store MIT cells), `:402-406` (pass to preview)

**Interfaces:**
```ts
// GameBoard Props
mitCells: Set<string>;     // cells of a validated MIT word; precedence accent > egg-mit > valid
// BoardPreview Props
mitCells?: Set<string>;
// lib/boards.ts
export interface BoardWords { validCells: Set<string>; mitCells: Set<string>; words: string[] }
```
CSS class: `.board-tile.egg-mit`; tokens `--color-tile-mit-bg`, `--color-tile-mit-border`, `--color-tile-mit-text`.

- [ ] **Step 1: Write the failing check** — with the stack up, run `npm run build:shared; npm run typecheck --workspace @plantain/web` after adding ONLY the GameBoard call-site prop in `Game.tsx` (`mitCells={mitCells}` next to `accentCells={xtinaAccents}`).

Expected: FAIL — `Cannot find name 'mitCells'` and `Property 'mitCells' does not exist on type 'IntrinsicAttributes & Props ...'`. (No web unit-test harness exists; the runtime proof is the browser check in Step 5.)

- [ ] **Step 2: Implement tokens + CSS.** In `tokens.css`, directly after `--color-tile-valid-border: #7fae57;`:

```css
  /* Easter egg: a validated MIT word tints MIT cardinal (maroon) instead of the valid green.
     Tokenized so colorblind modes can retint it (see styles.css colorblind blocks). */
  --color-tile-mit-bg: #a31f34;
  --color-tile-mit-border: #6e1423;
  --color-tile-mit-text: #fbf4e2;
```

In `styles.css`, directly after the `.board-tile.valid { ... }` rule:

```css
/* Easter egg MIT. Overrides .valid (never composed with it — GameBoard/BoardPreview pick one
   class), same precedence pattern as the xtina .accent below. Text and lip are retinted too so a
   light-on-dark tile never sits on the green --color-tile-shadow. */
.board-tile.egg-mit {
  background: var(--color-tile-mit-bg);
  border-color: var(--color-tile-mit-border);
  color: var(--color-tile-mit-text);
  box-shadow: 0 2px 0 var(--color-tile-mit-border);
}
```

In the colorblind blocks, add to the `deuteranopia, protanopia` block (after `--color-tile-valid-border: #3d7cbf;`):

```css
  --color-tile-mit-bg: #d55e00;
  --color-tile-mit-border: #8f3f00;
```

and to the `tritanopia` block (after `--color-tile-valid-border: #009e73;`):

```css
  --color-tile-mit-bg: #d55e00;
  --color-tile-mit-border: #8f3f00;
```

(Okabe-Ito vermillion: distinct from every mode's retinted valid colour.)

- [ ] **Step 3: Implement the components.**

`GameBoard.tsx` — in `interface Props`, after the `accentCells` member:

```ts
  /** Cells of a validated MIT word (easter egg) — maroon. Below `accentCells`, above `validCells`. */
  mitCells: Set<string>;
```

add `mitCells,` to the destructure after `accentCells,`, and replace the tile `className` line with:

```tsx
              className={`board-tile${
                accentCells.has(key) ? ' accent' : mitCells.has(key) ? ' egg-mit' : validCells.has(key) ? ' valid' : ''
              }${selected ? ' selected' : ''}`}
```

`BoardPreview.tsx` — in `interface Props` after `accentCells?`:

```ts
  /** Cells of a validated MIT word (easter egg) — maroon, between accent and valid, as in-game. */
  mitCells?: Set<string>;
```

add `mitCells,` to the destructure after `accentCells,`, and replace the tile className with:

```tsx
              className={`board-tile${
                accentCells?.has(key)
                  ? ' accent'
                  : mitCells?.has(key)
                    ? ' egg-mit'
                    : validCells?.has(key)
                      ? ' valid'
                      : ''
              }`}
```

`lib/boards.ts` — replace the `BoardWords` interface and `EMPTY_BOARD_WORDS`:

```ts
export interface BoardWords {
  /** Cell keys belonging to a dictionary-valid word — tinted green, same cue as in-game. */
  validCells: Set<string>;
  /** Cell keys of a valid MIT word (easter egg) — tinted maroon, same cue as in-game. */
  mitCells: Set<string>;
  /** The valid words on this board, in reading order. */
  words: string[];
}

export const EMPTY_BOARD_WORDS: BoardWords = { validCells: new Set(), mitCells: new Set(), words: [] };
```

and replace the tail of `resolveBoardWords` (from `const validCells = new Set<string>();` to the end of the function) with:

```ts
  const validCells = new Set<string>();
  const mitCells = new Set<string>();
  const words: string[] = [];
  for (const w of found) {
    if (invalid.has(w.word)) continue;
    words.push(w.word);
    for (const c of w.cells) if (!bad.has(c)) validCells.add(c);
  }
  // Same cross-word rule as the green tint: a MIT cell crossing an invalid word stays untinted.
  for (const w of found) {
    if (w.word === 'MIT' && w.cells.every((c) => validCells.has(c))) for (const c of w.cells) mitCells.add(c);
  }
  return { validCells, mitCells, words };
```

`Game.tsx` — add `EASTER_EGG_WORDS,` to the `@plantain/shared` import. Replace the `wordVerdictsRef` declaration with:

```ts
  // Seeded with the easter-egg words: they are valid under EVERY config (the server agrees — see
  // migration 20261006000401), so they never need a /validate round trip.
  const wordVerdictsRef = useRef<Map<string, boolean>>(new Map(EASTER_EGG_WORDS.map((w) => [w, true])));
```

Directly after the `xtinaAccents` `useMemo`, add:

```ts
  // Easter egg MIT: a VALIDATED MIT word tints maroon. "Validated" = every one of its cells is in
  // validCells, so the cross-word rule applies (a MIT crossing an invalid word doesn't tint).
  // EMPTY_CELLS when absent keeps the prop identity stable for the memo'd GameBoard.
  const mitCells = useMemo(() => {
    const cells = new Set<string>();
    for (const w of extractWordsWithCells(grid)) {
      if (w.word === 'MIT' && w.cells.every((c) => validCells.has(c))) for (const c of w.cells) cells.add(c);
    }
    return cells.size > 0 ? cells : EMPTY_CELLS;
  }, [grid, validCells]);
```

`BoardViewer.tsx` — add `mitCells={words.mitCells}` to the `<BoardPreview` after `accentCells={scriptedAccents}`.

`Results.tsx` — add state next to `myBoard`:

```ts
  const [myMitCells, setMyMitCells] = useState<Set<string>>(new Set());
```

in the boards effect replace `const { words } = await resolveBoardWords(roomId!, mine.grid_state);` with
`const { words, mitCells } = await resolveBoardWords(roomId!, mine.grid_state);` and add
`setMyMitCells(mitCells);` immediately after the `if (cancelled || seq !== latestSeq) return;` that follows it.
Add `mitCells={myMitCells}` to the Results `<BoardPreview` (the one with `label="Your final board"`).

- [ ] **Step 4: Run typecheck to verify it passes**

Run: `npm run build:shared; npm run typecheck --workspace @plantain/web` → Expected: exit 0, no errors.

- [ ] **Step 5: Browser check (the actual proof).** Start `web` and `api` via `preview_start` (`.claude/launch.json` names `web`, `api`). Open the app, then in the page:

```js
const k = Object.keys(sessionStorage).find((x) => x.endsWith('-auth-token'));
JSON.parse(sessionStorage.getItem(k)).user.id
```

With that id as `<UID>`, from the repo root run (Git Bash):

```bash
node --input-type=module -e "
import pg from 'pg';
const c = new pg.Client({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' });
await c.connect();
const uid = '<UID>';
const r = (await c.query(\"select public.create_room(\$1,'Tester',null) as r\", [uid])).rows[0].r;
await c.query('select public.start_game(\$1,\$2)', [r.roomId, uid]);
await c.query(\"update public.rooms set mode='solo', mode_config='{\\\"bunchSize\\\":144,\\\"timed\\\":false}' where id=\$1\", [r.roomId]);
await c.query(\"update public.room_players set rack='[\\\"M\\\",\\\"I\\\",\\\"T\\\",\\\"C\\\",\\\"A\\\"]'::jsonb, tile_count=5, grid_state='{\\\"20,20\\\":\\\"M\\\",\\\"21,20\\\":\\\"I\\\",\\\"22,20\\\":\\\"T\\\"}'::jsonb where room_id=\$1\", [r.roomId]);
console.log(r.roomId);
await c.end();"
```

Navigate to `/room/<roomId>/game`. Inject `*{transition:none!important}` (per CLAUDE.md — the pane freezes transitions), then evaluate:

```js
[...document.querySelectorAll('.board-tile.egg-mit')].map((t) => [t.textContent, getComputedStyle(t).backgroundColor])
```

Expected: three entries `M`, `I`, `T`, each `rgb(163, 31, 52)`; and `document.querySelectorAll('.board-tile.valid').length === 0`. Take a screenshot. Then set `document.documentElement.dataset.colorblind = 'deuteranopia'` and re-evaluate: expected `rgb(213, 94, 0)`. Then finish the room (`update public.rooms set status='finished', finished_at=now(), winner_id='<UID>' where id='<roomId>'` via the same `node -e` pattern), navigate to `/room/<roomId>/board`, and re-run the selector: expected the same three maroon tiles in the BoardPreview. Record exactly what was and was not observed.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/styles/tokens.css apps/web/src/styles.css apps/web/src/components/GameBoard.tsx apps/web/src/components/BoardPreview.tsx apps/web/src/lib/boards.ts apps/web/src/pages/Game.tsx apps/web/src/pages/BoardViewer.tsx apps/web/src/pages/Results.tsx
git commit -m "feat(web): easter egg MIT tints maroon; egg words valid locally without a request

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `useEasterEggs` hook — fire each egg's trigger once per game

**Files:**
- Create: `apps/web/src/hooks/useEasterEggs.ts`
- Modify: `apps/web/src/pages/Game.tsx` — imports (`useEasterEggs`, `isEasterEggWord`), and a new block immediately after the "Publish tiles remaining" effect (the one ending `}, [remainingCount, roomId]);`, ~:1386)

**Interfaces:**
```ts
export type EggTrigger = () => void | boolean | Promise<void | boolean>;   // false = re-arm
export type EggTriggers = Partial<Record<EggWord, EggTrigger>>;
export function useEasterEggs(eggsOnBoard: ReadonlySet<string>, triggers: EggTriggers): { getFoundEggs: () => EggWord[] };
// Game.tsx locals created here and used by Tasks 5-8:
const eggsOnBoard: ReadonlySet<string>;
const eggTriggers: EggTriggers;          // Tasks 5-7 add GHOST / FREEZE / SUPERCALI entries
const { getFoundEggs } = useEasterEggs(eggsOnBoard, eggTriggers);
```

**User contribution candidate:** the trigger-once / re-arm policy inside the effect (the ~8 lines
from `for (const egg of fresh)` to the end of the loop). The design choice: an egg is "found" the
moment it first appears (so GHOST/achievements count even if the word is later broken), but a
trigger may resolve `false` to re-arm itself — Supercali needs that, because the server can refuse
a win (e.g. a stray disconnected tile) and the player must get another try once they fix the board,
while GHOST/FREEZE must never re-fire. Alternatives worth weighing: re-arm only after the word
*leaves* the board (stricter, no request per tile move), or re-arm on every board change (simplest,
what the reference does, made cheap by the client pre-checks in Task 7). Reference code below.

- [ ] **Step 1: Write the failing check** — add only the `Game.tsx` usage block from Step 3 (with `const eggTriggers: EggTriggers = {};`), then run:

Run: `npm run build:shared; npm run typecheck --workspace @plantain/web`
Expected: FAIL — `Cannot find module '../hooks/useEasterEggs.js'`. (The pure rule, `newlyFoundEggs`, is already unit-tested in Task 1.)

- [ ] **Step 2: Implement the hook** — create `apps/web/src/hooks/useEasterEggs.ts`:

```ts
import { useCallback, useEffect, useRef } from 'react';
import { newlyFoundEggs, type EggWord } from '@plantain/shared';

/** Runs when its egg first appears validly on the board. Resolving to `false` (or throwing)
 * re-arms it, so it fires again the next time the board changes while the word is still up. */
export type EggTrigger = () => void | boolean | Promise<void | boolean>;
export type EggTriggers = Partial<Record<EggWord, EggTrigger>>;

/**
 * Watches the set of egg words currently validly on the local board and fires each egg's trigger
 * once per game. Game.tsx remounts per room, so "per game" is simply "per mount" — the refs below
 * reset on their own for a rematch.
 *
 * `found` is sticky and separate from `fired`: an egg counts as found the moment it first appears,
 * even if its trigger later re-arms or the word is broken — that's what the end-of-game summary
 * reports (eggs_found) and what GHOST's "even if you later break the word" relies on.
 */
export function useEasterEggs(
  eggsOnBoard: ReadonlySet<string>,
  triggers: EggTriggers,
): { getFoundEggs: () => EggWord[] } {
  const firedRef = useRef<Set<EggWord>>(new Set());
  const foundRef = useRef<Set<EggWord>>(new Set());
  // Latest handlers without making them effect dependencies: Game rebuilds them every render.
  const triggersRef = useRef(triggers);
  triggersRef.current = triggers;

  useEffect(() => {
    const fresh = newlyFoundEggs(eggsOnBoard, firedRef.current);
    for (const egg of fresh) {
      firedRef.current.add(egg);
      foundRef.current.add(egg);
      const trigger = triggersRef.current[egg];
      if (!trigger) continue;
      Promise.resolve()
        .then(trigger)
        .then((ok) => {
          if (ok === false) firedRef.current.delete(egg);
        })
        .catch(() => firedRef.current.delete(egg));
    }
  }, [eggsOnBoard]);

  const getFoundEggs = useCallback(() => [...foundRef.current], []);
  return { getFoundEggs };
}
```

- [ ] **Step 3: Wire it into `Game.tsx`.** Add `import { useEasterEggs, type EggTriggers } from '../hooks/useEasterEggs.js';` and `isEasterEggWord,` to the `@plantain/shared` import. Immediately after the "Publish tiles remaining" effect add:

```ts
  // --- Easter eggs ------------------------------------------------------------

  // Egg words currently validly on the board. With word validation on, "validly" = every cell of
  // the word is in validCells (so an egg crossing an invalid word doesn't count). With validation
  // off there is no verdict for crossing words at all, but an egg needs no dictionary — count it
  // on presence; anything with a real consequence (Supercali) is re-validated by the Worker.
  const eggsOnBoard = useMemo(() => {
    const out = new Set<string>();
    for (const w of extractWordsWithCells(grid)) {
      if (!isEasterEggWord(w.word)) continue;
      if (!wordValidationEnabled || w.cells.every((c) => validCells.has(c))) out.add(w.word);
    }
    return out;
  }, [grid, validCells, wordValidationEnabled]);

  // MIT has no trigger — its tint is continuous (mitCells). GHOST / FREEZE / SUPERCALI are added
  // by the tasks that implement them; an egg without a trigger is still recorded as found.
  const eggTriggers: EggTriggers = {};

  const { getFoundEggs } = useEasterEggs(eggsOnBoard, eggTriggers);
```

- [ ] **Step 4: Run typecheck to verify it passes**

Run: `npm run build:shared; npm run typecheck --workspace @plantain/web` → Expected: exit 0. (`getFoundEggs` is unused until Task 8; if `noUnusedLocals` flags it, prefix with `void getFoundEggs;` on the next line and remove that line in Task 8.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/useEasterEggs.ts apps/web/src/pages/Game.tsx
git commit -m "feat(web): useEasterEggs fires each egg trigger once per game

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: GHOST — per-room egg state, masked counts, "??" pills, cleared on rematch

**Files:**
- Create: `supabase/migrations/20261006000402_egg_room_state.sql`
- Latest definitions replaced: `room_players_public` (`20260728000003_player_progress.sql:21-27`), `rooms_public` (`20260910000001_room_state_version.sql:81-86`), `rematch_room` (`20260728000006_stats_scale_with_users.sql:381-436`)
- Modify: `apps/api/src/index.ts:347-361` (`POST /rooms/:roomId/progress`), `apps/api/src/rpcError.ts:2-42`
- Modify: `apps/web/src/lib/api.ts:208-212` (add `reportEggFlags`), `apps/web/src/lib/rooms.ts:15-49` (types)
- Modify: `apps/web/src/pages/Game.tsx:1666-1671` (`playerCount`), the `eggTriggers` object from Task 4
- Modify: `scripts/smoke-easter-eggs.mjs` (add `sectionGhost`)

**Interfaces:**
```sql
alter table room_players add ghosted boolean not null default false, add freeze_used boolean not null default false;
alter table rooms add win_kind text check (win_kind in ('supercali'));
public.report_egg_flags(p_room_id uuid, p_profile uuid, p_flags jsonb) returns jsonb
  -- p_flags: {"ghosted": true} and/or {"freezeUsed": true}; returns {ok, ghosted, freezeUsed}
-- room_players_public: tile_count/remaining_count NULL while ghosted AND room active; appends ghosted, freeze_used
-- rooms_public: appends win_kind
```
```ts
// api.ts
reportEggFlags(roomId: string, flags: { ghosted?: true; freezeUsed?: true }): Promise<{ ok: true }>;
// rooms.ts
PublicPlayer.tile_count: number | null; PublicPlayer.ghosted?: boolean; PublicPlayer.freeze_used?: boolean;
PublicRoom.win_kind?: 'supercali' | null;
```

- [ ] **Step 1: Write the failing smoke section.** In `scripts/smoke-easter-eggs.mjs`, add above `const SECTIONS`:

```js
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
```

and change `const SECTIONS = [sectionEggValidation];` to `const SECTIONS = [sectionEggValidation, sectionGhost];`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/smoke-easter-eggs.mjs ghost`
Expected: FAIL — `column "ghosted" does not exist`.

- [ ] **Step 3: Write the migration** — create `supabase/migrations/20261006000402_egg_room_state.sql`:

```sql
-- Phase 4 easter eggs: per-room egg state. Lives on the ROOM (room_players / rooms) so it dies with
-- the room and needs no cleanup of its own; rematch_room resets it for game 2.
--
--   room_players.ghosted     GHOST validly appeared on this player's board. Opponents then see the
--                            player's tile_count / remaining_count as NULL (rendered "??") for the
--                            rest of the game, even if the word is later broken (no un-ghost path).
--   room_players.freeze_used FREEZE fired in a Timed solo game; _archive_game_impl subtracts
--                            10000 ms from the duration (migration 20261006000403). Client-reported
--                            and spoofable — accepted (spec 4.1).
--   rooms.win_kind           'supercali' when the game ended via supercali_win (20261006000404);
--                            Results shows a special callout off it.

alter table public.room_players
  add column ghosted boolean not null default false,
  add column freeze_used boolean not null default false;

alter table public.rooms
  add column win_kind text check (win_kind in ('supercali'));

-- ---------------------------------------------------------------------------
-- room_players_public — counts masked for a ghosted player while the game is ACTIVE (a finished
-- room shows the real final numbers again). Same columns in the same order with two appended at
-- the end (replace-safe); joins rooms for the status, which security_invoker = false reads past RLS
-- exactly as it already reads room_players.
-- ---------------------------------------------------------------------------
create or replace view public.room_players_public
with (security_invoker = false) as
  select rp.room_id, rp.profile_id, rp.display_name, rp.seat,
         rp.is_ready, rp.is_spectator,
         case when rp.ghosted and r.status = 'active' then null else rp.tile_count end as tile_count,
         rp.connected, rp.joined_at,
         rp.avatar_config,
         case when rp.ghosted and r.status = 'active' then null else rp.remaining_count end as remaining_count,
         rp.ghosted, rp.freeze_used
  from public.room_players rp
  join public.rooms r on r.id = rp.room_id
  where public.is_room_member(rp.room_id);

-- rooms_public — append win_kind (replace-safe, new column at the end).
create or replace view public.rooms_public
with (security_invoker = false) as
  select r.id, r.code, r.host_id, r.status, r.dictionary_config,
         r.bunch_count, r.winner_id, r.created_at, r.started_at, r.finished_at,
         r.mode, r.mode_config, r.state_version, r.win_kind
  from public.rooms r
  where public.is_room_member(r.id) or r.host_id = auth.uid();

-- ---------------------------------------------------------------------------
-- report_egg_flags — a DEDICATED RPC rather than a new report_progress parameter: adding a param
-- to report_progress would create a second overload (CLAUDE.md). The Worker's existing
-- POST /rooms/:id/progress route calls this when the body carries flags.
--
-- Flags are one-way latches. GHOST broadcasts a 'progress' event (the type clients already refetch
-- the roster on) carrying only {profileId, ghosted} — no counts. FREEZE is accepted only for a
-- Timed solo room and broadcasts nothing (there is no one to tell).
-- ---------------------------------------------------------------------------
create or replace function public.report_egg_flags(p_room_id uuid, p_profile uuid, p_flags jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_rp public.room_players;
  v_flags jsonb := coalesce(p_flags, '{}'::jsonb);
  v_ghost boolean;
  v_freeze boolean;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_room.status <> 'active' then raise exception 'GAME_NOT_ACTIVE' using errcode = 'P0001'; end if;

  select * into v_rp from public.room_players
    where room_id = p_room_id and profile_id = p_profile
    for update;
  if not found then raise exception 'NOT_IN_ROOM' using errcode = 'P0002'; end if;

  -- jsonb equality, not a ::boolean cast: a non-boolean value is simply "not set", never a 22P02.
  v_ghost := (v_flags -> 'ghosted') = 'true'::jsonb;
  v_freeze := (v_flags -> 'freezeUsed') = 'true'::jsonb
              and v_room.mode = 'solo'
              and coalesce((v_room.mode_config ->> 'timed')::boolean, false);

  if v_ghost and not v_rp.ghosted then
    update public.room_players set ghosted = true where id = v_rp.id;
    insert into public.room_events (room_id, type, payload)
      values (p_room_id, 'progress', jsonb_build_object('profileId', p_profile, 'ghosted', true));
  end if;

  if v_freeze and not v_rp.freeze_used then
    update public.room_players set freeze_used = true where id = v_rp.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'ghosted', v_rp.ghosted or v_ghost,
    'freezeUsed', v_rp.freeze_used or v_freeze
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- rematch_room — verbatim from 20260728000006, plus the [phase4] resets.
-- ---------------------------------------------------------------------------
create or replace function public.rematch_room(p_room_id uuid, p_profile uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_is_member boolean;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;

  select exists (
    select 1 from public.room_players where room_id = p_room_id and profile_id = p_profile
  ) into v_is_member;
  if not v_is_member then raise exception 'NOT_IN_ROOM' using errcode = 'P0002'; end if;

  if v_room.mode <> 'multiplayer' then
    raise exception 'NOT_MULTIPLAYER' using errcode = 'P0001';
  end if;

  if v_room.status = 'lobby' then
    return jsonb_build_object('roomId', v_room.id, 'code', v_room.code, 'alreadyReset', true);
  end if;
  if v_room.status <> 'finished' then
    raise exception 'GAME_NOT_FINISHED' using errcode = 'P0001';
  end if;

  update public.rooms set
    status = 'lobby',
    winner_id = null,
    started_at = null,
    finished_at = null,
    bunch = public._fresh_bunch(),
    bunch_count = 144,
    stats_applied = false,
    win_kind = null              -- [phase4]
  where id = p_room_id;

  update public.room_players set
    rack = '[]'::jsonb,
    grid_state = '{}'::jsonb,
    tile_count = 0,
    is_ready = false,
    remaining_count = null,
    summary_applied = false,
    ghosted = false,             -- [phase4]
    freeze_used = false          -- [phase4]
  where room_id = p_room_id;

  delete from public.room_events where room_id = p_room_id;

  insert into public.room_events (room_id, type, payload)
  values (p_room_id, 'rematch',
          jsonb_build_object('actor', p_profile, 'roomId', p_room_id, 'code', v_room.code));

  return jsonb_build_object('roomId', v_room.id, 'code', v_room.code, 'alreadyReset', false);
end;
$$;

do $$
begin
  execute 'revoke all on function public.report_egg_flags(uuid,uuid,jsonb) from public, anon, authenticated';
  execute 'grant execute on function public.report_egg_flags(uuid,uuid,jsonb) to service_role';
end $$;
```

- [ ] **Step 4: Apply and run the section to verify it passes**

Run: `npx supabase migration up --local; node scripts/smoke-easter-eggs.mjs ghost`
Expected: 12 `ok` lines under `sectionGhost`, then `ALL PASSED`. Then `node scripts/smoke-easter-eggs.mjs` → both sections pass.

- [ ] **Step 5: Worker route.** Replace the whole `app.post('/rooms/:roomId/progress', ...)` handler in `apps/api/src/index.ts` with:

```ts
// Progress: the client reports its own private "tiles remaining" number (debounced) so
// opponents' pills mean something, and — Phase 4 easter eggs — one-way egg flags (GHOST hides
// your counts from opponents; FREEZE marks a Timed solo clock pause). Either or both may be sent.
// Dedupe/broadcast-on-change lives in the RPCs.
app.post('/rooms/:roomId/progress', async (c) => {
  const profileId = c.get('profileId');
  const roomId = c.req.param('roomId');
  const body = await c.req.json<{ remaining?: number; ghosted?: boolean; freezeUsed?: boolean }>();
  const hasFlags = body.ghosted === true || body.freezeUsed === true;
  if (body.remaining === undefined && !hasFlags) return c.json({ error: 'INVALID_REMAINING' }, 400);

  const admin = createAdminClient(c.env);
  if (body.remaining !== undefined) {
    const { error } = await admin.rpc('report_progress', {
      p_room_id: roomId,
      p_profile: profileId,
      p_remaining: body.remaining,
    });
    if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  }
  if (hasFlags) {
    const { error } = await admin.rpc('report_egg_flags', {
      p_room_id: roomId,
      p_profile: profileId,
      p_flags: { ghosted: body.ghosted === true, freezeUsed: body.freezeUsed === true },
    });
    if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  }
  return c.json({ ok: true });
});
```

(`report_progress` already returned `{ ok: true }`, so the response shape the client relies on is unchanged.)

- [ ] **Step 6: Client.** In `apps/web/src/lib/api.ts`, after `reportProgress`:

```ts
  /** Phase 4 easter-egg flags (one-way). Same route as reportProgress; see the Worker. */
  reportEggFlags: (roomId: string, flags: { ghosted?: true; freezeUsed?: true }) =>
    call<{ ok: true }>(`/rooms/${roomId}/progress`, {
      method: 'POST',
      body: JSON.stringify(flags),
    }),
```

In `apps/web/src/lib/rooms.ts`: in `PublicRoom` add after `state_version?: number;`

```ts
  /** 'supercali' when the game was won by the SUPERCALI… easter egg (migration 20261006000402).
   * Optional so a web deploy that lands before the migration degrades to a normal Results page. */
  win_kind?: 'supercali' | null;
```

in `PublicPlayer` change `tile_count: number;` to

```ts
  /** Null while this player is GHOSTed and the game is active (Phase 4 easter egg) — render "??". */
  tile_count: number | null;
```

and add after `remaining_count`:

```ts
  /** GHOST easter egg fired for this player this game (opponents see "??"). */
  ghosted?: boolean;
  /** FREEZE easter egg fired (Timed solo) — Results subtracts the frozen 10 s from the clock. */
  freeze_used?: boolean;
```

In `Game.tsx` replace `playerCount` with:

```ts
  function playerCount(p: PublicPlayer): number | '??' {
    // Self uses the live local count (no debounce lag on your own number); everyone else uses
    // what THEY last reported, falling back to the raw inventory size (tile_count) until their
    // client reports at least once this game. A GHOSTed opponent's counts come back null from
    // room_players_public for the rest of the game (Phase 4 easter egg) — shown as "??".
    if (p.profile_id === profileId) return remainingCount;
    if (p.ghosted || p.tile_count === null) return '??';
    return p.remaining_count ?? p.tile_count;
  }
```

and replace `const eggTriggers: EggTriggers = {};` with:

```ts
  const eggTriggers: EggTriggers = {
    // GHOST: opponents see "??" for the rest of the game. Only meaningful with opponents; solo and
    // daily still record it as found (achievements) but skip the request. A failed request re-arms
    // so the next board change retries; the server latch makes a repeat harmless.
    GHOST: async () => {
      if (!roomId || room?.mode !== 'multiplayer') return;
      try {
        await api.reportEggFlags(roomId, { ghosted: true });
      } catch {
        return false;
      }
    },
  };
```

In `rpcError.ts`, add to `KNOWN_ERRORS` after `INVALID_TIMED_FLAG: 400,`:

```ts
  // Easter eggs
  EXTRA_TILES: 400,
  NOT_CONNECTED: 400,
  ORPHAN_TILE: 400,
  NO_SUPERCALI: 400,
  EMPTY_GRID: 400,
```

- [ ] **Step 7: Typecheck**

Run: `npm run build:shared; npm run typecheck --workspace @plantain/api; npm run typecheck --workspace @plantain/web` → Expected: both exit 0.

- [ ] **Step 8: Two-session browser check.** In the Browser pane open two tabs (anonymous auth is per tab = two players), create a room in tab A, join in tab B, Split. Find tab A's user id (same `sessionStorage` snippet as Task 3) and give A a GHOST on the board by SQL (`update public.room_players set rack = rack || '["G","H","O","S","T"]'::jsonb, tile_count = tile_count + 5, grid_state = '{"10,10":"G","11,10":"H","12,10":"O","13,10":"S","14,10":"T"}'::jsonb where profile_id = '<A>' and room_id = '<room>'`), reload tab A (grid restores from `grid_state`). Expected within ~1 s: tab B's roster chip/pill for A reads `??` (`get_page_text` on tab B), while tab A still shows its own number. Record the observation honestly; if the reload path does not restore the grid, say so and fall back to the smoke result.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20261006000402_egg_room_state.sql scripts/smoke-easter-eggs.mjs apps/api/src/index.ts apps/api/src/rpcError.ts apps/web/src/lib/api.ts apps/web/src/lib/rooms.ts apps/web/src/pages/Game.tsx
git commit -m "feat: GHOST easter egg hides your tile count from opponents for the rest of the game

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: FREEZE — Timed solo clock pause, archived duration minus 10 s

**Files:**
- Create: `supabase/migrations/20261006000403_freeze_archive.sql`
- Latest definition replaced: `_archive_game_impl` (`supabase/migrations/20260924000003_daily_stats_archive.sql:7-208`). `archive_game` (`20260805000002_xtina_deal.sql:437-456`) is a wrapper and is NOT redefined.
- Modify: `apps/web/src/pages/Game.tsx` — imports (`FREEZE_DURATION_MS`), new refs/state near `elapsedMs` (:203), the ticker effect (:607-614), the elapsed card (:1704-1712), `eggTriggers`
- Modify: `apps/web/src/pages/Results.tsx:181-185` (`durationMs`)
- Modify: `apps/web/src/styles.css` (after the existing `.topbar-elapsed-card` rules)
- Modify: `scripts/smoke-easter-eggs.mjs` (add `sectionFreeze`)

**Interfaces:** none new beyond Task 5's `report_egg_flags` (`{"freezeUsed": true}`) and `room_players.freeze_used`; `_archive_game_impl(p_room_id uuid, p_winner uuid) returns jsonb` unchanged signature.

- [ ] **Step 1: Write the failing smoke section** — add above `const SECTIONS`:

```js
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
}
```

and append `sectionFreeze` to `SECTIONS`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/smoke-easter-eggs.mjs freeze`
Expected: FAIL — `FAIL: FREEZE: 70 s of wall clock archives as 60000 ms` (the first two assertions pass because Task 5 already records the flag; the archive still stores 70000).

- [ ] **Step 3: Write the migration** — create `supabase/migrations/20261006000403_freeze_archive.sql`:

```sql
-- Phase 4 easter egg FREEZE: in Timed solo, the client stops its clock for 10 s once per game and
-- reports it (room_players.freeze_used, via report_egg_flags). The archived duration — which feeds
-- solo_best_times — subtracts the same 10000 ms (packages/shared FREEZE_DURATION_MS). Client-
-- reported and spoofable; accepted by the spec. Daily is untouched: report_egg_flags never sets
-- freeze_used outside Timed solo, so daily rankings stay fair.
--
-- _archive_game_impl: verbatim from 20260924000003 plus the [phase4] lines (the loop also selects
-- freeze_used; the Timed-solo duration subtracts it).
create or replace function public._archive_game_impl(p_room_id uuid, p_winner uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_player_count int;
  v_split_at timestamptz;
  v_since timestamptz;
  v_p record;
  v_peels int;
  v_dumps int;
  v_peel_streak int;
  v_first_peel_at timestamptz;
  v_first_peel_ms int;
  v_is_winner boolean;
  v_game_date date;
  v_stat public.profile_stats;
  v_prof public.profiles;
  v_new_streak int;
  v_nail_biter boolean;
  v_agg_games int;
  v_agg_peels int;
  v_bunch_key text;
  v_duration_ms int;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;

  if v_room.stats_applied then
    return jsonb_build_object('ok', true, 'roomId', p_room_id, 'alreadyApplied', true);
  end if;

  v_since := coalesce(v_room.started_at, '-infinity'::timestamptz);

  select count(*) into v_player_count
    from public.room_players where room_id = p_room_id and not is_spectator;

  select min(created_at) into v_split_at
    from public.room_events
    where room_id = p_room_id and type = 'game_started' and created_at >= v_since;

  select exists (
    select 1 from public.room_players
    where room_id = p_room_id
      and not is_spectator
      and profile_id <> p_winner
      and remaining_count = 1
  ) into v_nail_biter;

  v_game_date := coalesce(v_room.finished_at, now())::date;

  for v_p in
    select profile_id, tile_count, freeze_used  -- [phase4] freeze_used
    from public.room_players
    where room_id = p_room_id and not is_spectator
    order by seat
  loop
    select count(*) into v_peels from public.room_events
      where room_id = p_room_id and type = 'peel'
        and payload ->> 'actor' = v_p.profile_id::text and created_at >= v_since;
    select count(*) into v_dumps from public.room_events
      where room_id = p_room_id and type = 'dump'
        and payload ->> 'actor' = v_p.profile_id::text and created_at >= v_since;
    select min(created_at) into v_first_peel_at from public.room_events
      where room_id = p_room_id and type = 'peel'
        and payload ->> 'actor' = v_p.profile_id::text and created_at >= v_since;
    v_first_peel_ms := case when v_first_peel_at is not null and v_split_at is not null
      then (extract(epoch from (v_first_peel_at - v_split_at)) * 1000)::int end;

    v_is_winner := v_p.profile_id = p_winner;

    if v_room.mode = 'multiplayer' then
      v_peel_streak := public._best_peel_streak(p_room_id, v_p.profile_id, v_since);
    else
      v_peel_streak := 0;
    end if;

    select * into v_stat from public.profile_stats
      where profile_id = v_p.profile_id and mode = v_room.mode;
    if not found then
      insert into public.profile_stats (
        profile_id, mode, games_played, games_won, total_peels, total_dumps,
        fastest_peel_ms, best_peel_streak, updated_at
      ) values (
        v_p.profile_id, v_room.mode, 1, (v_is_winner)::int, v_peels, v_dumps,
        v_first_peel_ms, v_peel_streak, now()
      );
    else
      update public.profile_stats set
        games_played = v_stat.games_played + 1,
        games_won = v_stat.games_won + (v_is_winner)::int,
        total_peels = v_stat.total_peels + v_peels,
        total_dumps = v_stat.total_dumps + v_dumps,
        fastest_peel_ms = least(
          coalesce(v_stat.fastest_peel_ms, 2147483647),
          coalesce(v_first_peel_ms, 2147483647)),
        best_peel_streak = greatest(v_stat.best_peel_streak, v_peel_streak),
        updated_at = now()
      where profile_id = v_p.profile_id and mode = v_room.mode;
    end if;
    update public.profile_stats set fastest_peel_ms = null
      where profile_id = v_p.profile_id and mode = v_room.mode and fastest_peel_ms = 2147483647;

    -- Best time per Bunch size (Timed solo wins only).
    if v_room.mode = 'solo' and v_is_winner
       and coalesce((v_room.mode_config ->> 'timed')::boolean, false)
       and v_room.started_at is not null and v_room.finished_at is not null then
      v_bunch_key := v_room.mode_config ->> 'bunchSize';
      -- [phase4] FREEZE easter egg: the 10 s the clock stood still don't count.
      v_duration_ms := greatest(0,
        (extract(epoch from (v_room.finished_at - v_room.started_at)) * 1000)::int
        - case when v_p.freeze_used then 10000 else 0 end);
      update public.profile_stats set
        solo_best_times = jsonb_set(
          coalesce(solo_best_times, '{}'::jsonb),
          array[v_bunch_key],
          to_jsonb(least(coalesce((solo_best_times ->> v_bunch_key)::int, 2147483647), v_duration_ms)),
          true)
        where profile_id = v_p.profile_id and mode = 'solo';
    end if;

    -- Daily challenge: record this completion for the live beat-percent comparison
    -- (daily_results), and roll it into this profile's personal best/average.
    if v_room.mode = 'daily'
       and v_room.started_at is not null and v_room.finished_at is not null then
      v_duration_ms := greatest(0, (extract(epoch from (v_room.finished_at - v_room.started_at)) * 1000)::int);
      insert into public.daily_results (puzzle_id, profile_id, duration_ms)
      values ((v_room.mode_config ->> 'puzzleId')::uuid, v_p.profile_id, v_duration_ms)
      on conflict (puzzle_id, profile_id) do nothing;

      update public.profile_stats set
        daily_best_time_ms = least(coalesce(daily_best_time_ms, 2147483647), v_duration_ms),
        daily_total_time_ms = daily_total_time_ms + v_duration_ms
        where profile_id = v_p.profile_id and mode = 'daily';
      update public.profile_stats set daily_best_time_ms = null
        where profile_id = v_p.profile_id and mode = 'daily' and daily_best_time_ms = 2147483647;
    end if;

    select * into v_prof from public.profiles where id = v_p.profile_id;
    if v_prof.last_played_date = v_game_date then
      v_new_streak := v_prof.current_streak;
    elsif v_prof.last_played_date = v_game_date - 1 then
      v_new_streak := v_prof.current_streak + 1;
    else
      v_new_streak := 1;
    end if;
    update public.profiles set
      current_streak = v_new_streak,
      longest_streak = greatest(v_prof.longest_streak, v_new_streak),
      last_played_date = v_game_date
      where id = v_p.profile_id;

    if v_first_peel_ms is not null and v_first_peel_ms <= 60000 then
      perform public._unlock_achievement(v_p.profile_id, 'speed_peeler', jsonb_build_object('roomId', p_room_id, 'ms', v_first_peel_ms));
    end if;
    if v_is_winner and v_p.tile_count >= 100 then
      perform public._unlock_achievement(v_p.profile_id, 'marathon_mind', jsonb_build_object('roomId', p_room_id, 'tiles', v_p.tile_count));
    end if;
    if v_is_winner and v_dumps = 0 then
      perform public._unlock_achievement(v_p.profile_id, 'no_dumps_given', jsonb_build_object('roomId', p_room_id));
    end if;
    if v_player_count >= 8 then
      perform public._unlock_achievement(v_p.profile_id, 'full_house', jsonb_build_object('roomId', p_room_id));
    end if;
    if v_is_winner and v_nail_biter then
      perform public._unlock_achievement(v_p.profile_id, 'nail_biter', jsonb_build_object('roomId', p_room_id));
    end if;
    select coalesce(sum(games_played), 0), coalesce(sum(total_peels), 0)
      into v_agg_games, v_agg_peels
      from public.profile_stats where profile_id = v_p.profile_id;
    if v_agg_games >= 100 then
      perform public._unlock_achievement(v_p.profile_id, 'century_club', jsonb_build_object('games', v_agg_games));
    end if;
    if v_agg_peels >= 1000 then
      perform public._unlock_achievement(v_p.profile_id, 'peel_machine', jsonb_build_object('peels', v_agg_peels));
    end if;
  end loop;

  update public.rooms set stats_applied = true where id = p_room_id;

  return jsonb_build_object('ok', true, 'roomId', p_room_id, 'alreadyApplied', false);
end;
$$;

do $$
begin
  execute 'revoke all on function public._archive_game_impl(uuid,uuid) from public, anon, authenticated';
  execute 'grant execute on function public._archive_game_impl(uuid,uuid) to service_role';
end $$;
```

- [ ] **Step 4: Apply and run to verify it passes**

Run: `npx supabase migration up --local; node scripts/smoke-easter-eggs.mjs freeze` → Expected: 5 `ok` lines, `ALL PASSED`. Then `node scripts/smoke-easter-eggs.mjs` (all sections) and `node scripts/smoke-daily-stats.mjs` (regression: the daily branch is untouched) → both pass.

- [ ] **Step 5: Client clock.** In `Game.tsx` add `FREEZE_DURATION_MS,` to the shared import; next to `const [elapsedMs, setElapsedMs] = useState(0);` add:

```ts
  // FREEZE easter egg (Timed solo): when the clock stopped, or null. The ticker subtracts the frozen
  // span, so the display holds still for 10 s and then resumes 10 s behind wall clock — matching
  // what _archive_game_impl subtracts server-side.
  const freezeStartRef = useRef<number | null>(null);
  const [frozen, setFrozen] = useState(false);
```

Replace the ticker effect body's `const tick = () => setElapsedMs(Date.now() - startedAt);` with:

```ts
    const tick = () => {
      const now = Date.now();
      const fs = freezeStartRef.current;
      const frozenMs = fs === null ? 0 : Math.min(now, fs + FREEZE_DURATION_MS) - fs;
      setElapsedMs(now - startedAt - frozenMs);
    };
```

Replace the elapsed card's two lines

```tsx
            <div className="topbar-card topbar-elapsed-card">
              <span className="elapsed-label">Elapsed</span>
```

with

```tsx
            <div className={`topbar-card topbar-elapsed-card${frozen ? ' frozen' : ''}`}>
              <span className="elapsed-label">{frozen ? 'Frozen' : 'Elapsed'}</span>
```

Add to `eggTriggers` (after `GHOST`):

```ts
    // FREEZE: Timed solo only, once per game. Never re-arms — even if the report fails the local
    // clock already paused, and the worst case is the server not subtracting (accepted).
    FREEZE: async () => {
      if (!isTimed || !roomId || freezeStartRef.current !== null) return;
      freezeStartRef.current = Date.now();
      setFrozen(true);
      fireCallout('FREEZE!');
      setTimeout(() => setFrozen(false), FREEZE_DURATION_MS);
      try {
        await api.reportEggFlags(roomId, { freezeUsed: true });
      } catch {
        // see above — deliberately not re-armed
      }
    },
```

In `styles.css`, after the existing `.topbar-elapsed-card` / `.elapsed-value` rules:

```css
/* FREEZE easter egg: the Timed solo clock is standing still. Colour plus the "Frozen" label, so
   the state never relies on colour alone. */
.topbar-elapsed-card.frozen .elapsed-value {
  color: #8fd3f4;
}
```

In `Results.tsx` replace the `durationMs` declaration with:

```ts
  // Derived from the room's own timestamps rather than a stored duration_ms. A FREEZE easter egg
  // (Timed solo) took 10 s off the clock — the archived best time already subtracts it, so the
  // tile must too or the two disagree.
  const rawDurationMs =
    room.started_at && room.finished_at
      ? new Date(room.finished_at).getTime() - new Date(room.started_at).getTime()
      : null;
  const durationMs =
    rawDurationMs !== null && isTimed && me?.freeze_used
      ? Math.max(0, rawDurationMs - FREEZE_DURATION_MS)
      : rawDurationMs;
```

and add `FREEZE_DURATION_MS` to Results' `@plantain/shared` import.

- [ ] **Step 6: Typecheck + browser check.** Run `npm run build:shared; npm run typecheck --workspace @plantain/web` → exit 0. Browser: create a Timed solo game for the tab user via SQL like Task 3's fixture but `mode_config='{"bunchSize":144,"timed":true}'`, `rack` = `["F","R","E","E","Z","E","A"]`, `grid_state` = FREEZE at `20,20..25,20`. Load `/room/<id>/game`, then read `.elapsed-label` text and `.elapsed-value` twice 3 s apart: expected `Frozen` and an unchanged value; after ~11 s expected `Elapsed` and ticking. Confirm `select freeze_used from room_players where room_id = '<id>'` is true. Record observations honestly.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20261006000403_freeze_archive.sql scripts/smoke-easter-eggs.mjs apps/web/src/pages/Game.tsx apps/web/src/pages/Results.tsx apps/web/src/styles.css
git commit -m "feat: FREEZE easter egg stops the Timed solo clock for 10 seconds once per game

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: SUPERCALIFRAGILISTICEXPIALIDOCIOUS — instant win

**Files:**
- Create: `supabase/migrations/20261006000404_supercali_win.sql`
- Modify: `apps/api/src/index.ts` (imports; new route directly after the `/plantains` handler, ~:489)
- Modify: `packages/shared/src/stats.ts:125-127` (`validateGameSummary` word check) + `packages/shared/test/stats.test.ts`
- Modify: `apps/web/src/lib/api.ts:226-230` (add `supercali`), `apps/web/src/pages/Game.tsx` (imports, `eggTriggers`), `apps/web/src/pages/Results.tsx:188-200,268-273`, `apps/web/src/styles.css` (near `.results-callout`)
- Modify: `scripts/smoke-easter-eggs.mjs` (add `sectionSupercali`)

**Interfaces:**
```sql
public._grid_cells(p_grid jsonb) returns table (x int, y int, l text)           -- immutable helper
public.supercali_win(p_room_id uuid, p_profile uuid, p_grid jsonb) returns jsonb -- {ok:true, supercali:true}
  -- raises ROOM_NOT_FOUND | GAME_NOT_ACTIVE | NOT_IN_ROOM | MALFORMED_GRID | EXTRA_TILES | NOT_CONNECTED | NO_SUPERCALI
```
```ts
// Worker: POST /rooms/:roomId/supercali  body { grid }  → { ok: true, supercali: true }
// game_over event payload: { winner: string, supercali: true }
// api.ts
supercali(roomId: string, grid: GridState): Promise<{ ok: true; supercali: true }>;
```

- [ ] **Step 1: Write the failing tests.** Add above `const SECTIONS` in the smoke script:

```js
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
```

append `sectionSupercali` to `SECTIONS`. In `packages/shared/test/stats.test.ts` add inside `describe('validateGameSummary', ...)`:

```ts
  it('accepts an easter-egg word longer than the 20-letter custom-word cap', () => {
    expect(validateGameSummary({ ...good, words: ['CAT', 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS'] })).toEqual({
      valid: true,
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node scripts/smoke-easter-eggs.mjs supercali` → Expected: FAIL — `function public.supercali_win(uuid, uuid, jsonb) does not exist`.
Run: `npx vitest run --root packages/shared stats` → Expected: FAIL — received `{ valid: false, reason: 'INVALID_WORD' }` (a Supercali winner's whole summary would be rejected today).

- [ ] **Step 3: Write the migration** — create `supabase/migrations/20261006000404_supercali_win.sql`:

```sql
-- Phase 4 easter egg SUPERCALIFRAGILISTICEXPIALIDOCIOUS: validly on your board, it wins the game
-- instantly, in any mode, bypassing the bunch-low gate finish_game enforces.
--
-- The Worker (POST /rooms/:id/supercali) runs the shared validateSupercaliStructure and the
-- dictionary check first; this RPC re-checks the structural half authoritatively — the grid's
-- letters are a SUB-multiset of the caller's rack (other tiles may still be in hand), the grid is
-- one connected component (which, with >= 2 tiles, also rules out orphans), and SUPERCALI appears
-- as a whole word (a maximal horizontal or vertical run). Dictionary validity of the other words
-- stays in the Worker, exactly as for Plantains.
--
-- Like finish_game, this does NOT emit game_over: the Worker emits it after archive_game, flagged
-- {supercali: true}, so every client's Results page reads achievements that already exist.

create or replace function public._grid_cells(p_grid jsonb)
returns table (x int, y int, l text)
language sql
immutable
set search_path = public
as $$
  select split_part(e.key, ',', 1)::int, split_part(e.key, ',', 2)::int, upper(e.value)
  from jsonb_each_text(p_grid) e
$$;

create or replace function public.supercali_win(p_room_id uuid, p_profile uuid, p_grid jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_word constant text := 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS';
  v_len constant int := 34;
  v_room public.rooms;
  v_rp public.room_players;
  v_cells int;
  v_reached int;
  v_over boolean;
  v_has_word boolean;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_room.status <> 'active' then raise exception 'GAME_NOT_ACTIVE' using errcode = 'P0001'; end if;

  select * into v_rp from public.room_players
    where room_id = p_room_id and profile_id = p_profile and not is_spectator
    for update;
  if not found then raise exception 'NOT_IN_ROOM' using errcode = 'P0002'; end if;

  -- Shape: same rules as the shared isValidGridShape (key "x,y", single letter, <= 200 cells).
  if p_grid is null or jsonb_typeof(p_grid) <> 'object'
     or (select count(*) from jsonb_object_keys(p_grid)) > 200
     or exists (
       select 1 from jsonb_each(p_grid) e
       where e.key !~ '^-?\d{1,3},-?\d{1,3}$'
          or jsonb_typeof(e.value) <> 'string'
          or (e.value #>> '{}') !~ '^[A-Za-z]$'
     ) then
    raise exception 'MALFORMED_GRID' using errcode = 'P0001';
  end if;

  select count(*) into v_cells from public._grid_cells(p_grid);
  if v_cells < v_len then raise exception 'NO_SUPERCALI' using errcode = 'P0001'; end if;

  -- Sub-multiset: no letter used more times than the rack holds it.
  select exists (
    select 1
    from (select c.l, count(*) as n from public._grid_cells(p_grid) c group by c.l) g
    where g.n > (
      select count(*) from jsonb_array_elements_text(v_rp.rack) r where upper(r) = g.l
    )
  ) into v_over;
  if v_over then raise exception 'EXTRA_TILES' using errcode = 'P0001'; end if;

  -- Connectivity: flood fill from one cell; every cell must be reached.
  with recursive c as (
    select * from public._grid_cells(p_grid)
  ), reach (x, y) as (
    (select c.x, c.y from c order by c.y, c.x limit 1)
    union
    select c.x, c.y from reach r join c on abs(c.x - r.x) + abs(c.y - r.y) = 1
  )
  select count(*) into v_reached from reach;
  if v_reached <> v_cells then raise exception 'NOT_CONNECTED' using errcode = 'P0001'; end if;

  -- The word as a maximal run starting at some S: empty cell before it, empty cell after it, and
  -- the 34 cells between spell it (a gap makes string_agg shorter, so it can't match).
  with c as (select * from public._grid_cells(p_grid))
  select exists (
    select 1 from c s
    where s.l = 'S'
      and (
        (not exists (select 1 from c b where b.y = s.y and b.x = s.x - 1)
         and not exists (select 1 from c a where a.y = s.y and a.x = s.x + v_len)
         and (select string_agg(r.l, '' order by r.x) from c r
                where r.y = s.y and r.x between s.x and s.x + v_len - 1) = v_word)
        or
        (not exists (select 1 from c b where b.x = s.x and b.y = s.y - 1)
         and not exists (select 1 from c a where a.x = s.x and a.y = s.y + v_len)
         and (select string_agg(r.l, '' order by r.y) from c r
                where r.x = s.x and r.y between s.y and s.y + v_len - 1) = v_word)
      )
  ) into v_has_word;
  if not v_has_word then raise exception 'NO_SUPERCALI' using errcode = 'P0001'; end if;

  -- The board for the post-game viewer (what persist_grid would otherwise write).
  update public.room_players set grid_state = p_grid where id = v_rp.id;

  update public.rooms
    set status = 'finished', winner_id = p_profile, finished_at = now(), win_kind = 'supercali'
    where id = p_room_id;

  -- Mystery achievement. An xtina game never touches achievements (same rule as archive_game).
  if v_room.mode <> 'xtina' then
    perform public._unlock_achievement(p_profile, 'practically_perfect', jsonb_build_object('roomId', p_room_id));
  end if;

  return jsonb_build_object('ok', true, 'supercali', true);
end;
$$;

do $$
begin
  execute 'revoke all on function public._grid_cells(jsonb) from public, anon, authenticated';
  execute 'grant execute on function public._grid_cells(jsonb) to service_role';
  execute 'revoke all on function public.supercali_win(uuid,uuid,jsonb) from public, anon, authenticated';
  execute 'grant execute on function public.supercali_win(uuid,uuid,jsonb) to service_role';
end $$;
```

In `packages/shared/src/stats.ts` add `import { isEasterEggWord } from './easterEggs.js';` under the existing import, and replace the word loop's condition line

```ts
    if (typeof w !== 'string' || !WORD_PATTERN.test(w)) return { valid: false, reason: 'INVALID_WORD' };
```

with

```ts
    // Egg words are exempt from the 2-20 custom-word pattern: SUPERCALI… is 34 letters and is
    // exactly the word a Supercali winner's summary will contain.
    if (typeof w !== 'string' || !(WORD_PATTERN.test(w) || isEasterEggWord(w))) {
      return { valid: false, reason: 'INVALID_WORD' };
    }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx supabase migration up --local; node scripts/smoke-easter-eggs.mjs supercali` → Expected: 15 `ok` lines, `ALL PASSED`.
Run: `npm run test:shared` → Expected: all PASS.

- [ ] **Step 5: Worker route.** In `apps/api/src/index.ts` add `validateSupercaliStructure,` to the `@plantain/shared` import, and directly after the `/plantains` handler add:

```ts
// Supercali! (Phase 4 easter egg): SUPERCALIFRAGILISTICEXPIALIDOCIOUS validly on the board wins
// instantly, in any mode. Unlike Plantains the grid need only use a SUB-multiset of the rack
// (tiles may still be in hand) and the bunch-low gate does not apply. supercali_win re-checks the
// structural half authoritatively; the dictionary check lives here, exactly as for Plantains.
// A refusal appends nothing (plantains_rejected feeds Nail Biter and must stay Plantains-only).
app.post('/rooms/:roomId/supercali', async (c) => {
  const profileId = c.get('profileId');
  const roomId = c.req.param('roomId');
  const body = await c.req.json<{ grid: unknown }>();
  if (!isValidGridShape(body.grid)) return c.json({ error: 'MALFORMED_GRID' }, 400);
  const grid = body.grid;
  const admin = createAdminClient(c.env);

  let rack;
  try {
    rack = await fetchRack(admin, roomId, profileId);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 403);
  }

  const structural = validateSupercaliStructure(grid, rack);
  if (!structural.valid) {
    return c.json({ error: structural.reason, orphans: structural.orphans }, 400);
  }

  const { data: invalidWords, error: dictError } = await admin.rpc('find_invalid_words', {
    p_room_id: roomId,
    p_words: structural.words,
  });
  if (dictError) return c.json({ error: dictError.message }, statusForRpcError(dictError.message));
  if (invalidWords && invalidWords.length > 0) {
    return c.json({ error: 'INVALID_WORDS', invalidWords }, 400);
  }

  const { data, error } = await admin.rpc('supercali_win', {
    p_room_id: roomId,
    p_profile: profileId,
    p_grid: grid,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));

  // Same rule as Plantains: a rollup failure must not fail the win, and game_over fires either way.
  try {
    const { error: rollupError } = await admin.rpc('archive_game', {
      p_room_id: roomId,
      p_winner: profileId,
    });
    if (rollupError) console.error('stat rollup failed', rollupError.message);
  } catch (err) {
    console.error('stat rollup threw', (err as Error).message);
  }

  await admin.rpc('append_room_event', {
    p_room_id: roomId,
    p_type: 'game_over',
    p_payload: { winner: profileId, supercali: true },
  });

  return c.json(data as object);
});
```

- [ ] **Step 6: Client.** In `api.ts`, after `plantains`:

```ts
  supercali: (roomId: string, grid: GridState) =>
    call<{ ok: true; supercali: true }>(`/rooms/${roomId}/supercali`, {
      method: 'POST',
      body: JSON.stringify({ grid }),
    }),
```

In `Game.tsx` add `SUPERCALI, isConnected, findOrphans,` to the shared import; add near the other module-level constants (by `CALLOUT_MS`):

```ts
/** Supercali refusals that just mean "not yet" — the trigger re-arms silently. */
const SUPERCALI_SILENT_ERRORS = new Set([
  'EXTRA_TILES',
  'NOT_CONNECTED',
  'ORPHAN_TILE',
  'NO_SUPERCALI',
  'EMPTY_GRID',
  'INVALID_WORDS',
  'GAME_NOT_ACTIVE',
]);
```

and add to `eggTriggers` (after `FREEZE`):

```ts
    // SUPERCALI…: instant win. Cheap local pre-checks first (connected, no orphans, every placed
    // tile in a valid word) so a refusal is rare; a refusal re-arms so fixing the board retries.
    [SUPERCALI]: async () => {
      if (!roomId || busyRef.current || isXtinaPartner) return false;
      const g = gridRef.current;
      if (!isConnected(g) || findOrphans(g).length > 0) return false;
      if (wordValidationEnabled && Object.keys(g).some((k) => !validCells.has(k))) return false;
      busyRef.current = true;
      try {
        await api.supercali(roomId, g);
        submitSummaryOnce();
        fireCallout('SUPERCALI!');
        setTimeout(() => navigate(`/room/${roomId}/results`, { replace: true }), CALLOUT_MS);
        return true;
      } catch (err) {
        if (!(err instanceof ApiError && SUPERCALI_SILENT_ERRORS.has(err.message))) reportActionError(err);
        return false;
      } finally {
        busyRef.current = false;
      }
    },
```

In `Results.tsx` add `SUPERCALI` to the shared import; after `const isTimed = ...` add:

```ts
  const isSupercali = room.win_kind === 'supercali';
```

change the headline's non-daily tail from

```ts
    : isSolo
      ? 'You cleared the Bunch!'
```

to

```ts
    : isSupercali
      ? won
        ? 'Practically perfect. Instant win!'
        : `${winnerName} said the magic word.`
      : isSolo
        ? 'You cleared the Bunch!'
```

(keeping the remaining `: won ? ... : ...` branches, re-indented one level), and replace the non-daily `<h1 className="results-callout">PLANTAINS!</h1>` with:

```tsx
          <h1 className={`results-callout${isSupercali ? ' results-callout-supercali' : ''}`}>
            {isSupercali ? SUPERCALI : 'PLANTAINS!'}
          </h1>
```

In `styles.css` after the `.results-callout` rule(s):

```css
/* Supercali easter-egg win: the 34-letter word as the callout. Smaller fluid size and anywhere-
   wrapping so it never overflows a 280px phone (the 2026-07-27 mobile rule). */
.results-callout.results-callout-supercali {
  font-size: clamp(1.1rem, 5.2vw, 2.4rem);
  line-height: 1.05;
  overflow-wrap: anywhere;
  text-align: center;
}
```

- [ ] **Step 7: Typecheck + live check.** Run `npm run build:shared; npm run typecheck --workspace @plantain/api; npm run typecheck --workspace @plantain/web` → exit 0. Live HTTP check with the dev Worker running: create a 2-player room for two browser tabs, give tab A's rack SUPERCALI's 34 letters plus `Q`,`I` and `grid_state` = the word at `5..38,10` via SQL, reload tab A. Expected: tab A calls `POST /rooms/<id>/supercali` (visible in `read_network_requests`), shows SUPERCALI!, lands on Results with the long callout and "Practically perfect. Instant win!"; tab B lands on Results with "<name> said the magic word." At 280px width (hard-width wrapper div per CLAUDE.md, not `resize_window` alone) the callout has no horizontal overflow. Record what was observed.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20261006000404_supercali_win.sql scripts/smoke-easter-eggs.mjs apps/api/src/index.ts packages/shared/src/stats.ts packages/shared/test/stats.test.ts apps/web/src/lib/api.ts apps/web/src/pages/Game.tsx apps/web/src/pages/Results.tsx apps/web/src/styles.css
git commit -m "feat: SUPERCALIFRAGILISTICEXPIALIDOCIOUS easter egg wins the game instantly

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Mystery achievements + cumulative egg tracking

**Files:**
- Modify: `packages/shared/src/achievements.ts` (whole file), `packages/shared/src/stats.ts:52-60` (`GameSummary`), `:113-147` (`validateGameSummary`)
- Create: `packages/shared/test/achievements.test.ts`; Modify: `packages/shared/test/stats.test.ts`
- Create: `supabase/migrations/20261006000405_egg_achievements.sql`
- Latest definitions replaced: `submit_game_summary` (`20260808000002_stats_peel_streak_favorite_letter.sql:232-348`), `_archive_game_impl` (`20261006000403_freeze_archive.sql`, from Task 6)
- Modify: `apps/web/src/pages/Game.tsx:639-647` (`submitSummaryOnce`), `apps/web/src/pages/Profile.tsx:3-6,590-610`, `apps/web/src/pages/Results.tsx` (daily speedrun line), `apps/web/src/styles.css:3632-3669`
- Modify: `scripts/smoke-easter-eggs.mjs` (add `sectionMysteryAchievements`)

**Interfaces:**
```ts
export type AchievementType = ... | 'egg_hunter' | 'mind_and_hand' | 'practically_perfect' | 'collector' | 'speedrun';
export interface AchievementDef { title: string; description: string; hidden?: boolean; hint?: string }
export function achievementDisplay(type: AchievementType, unlocked: boolean): { title: string; description: string; mystery: boolean };
export interface GameSummary { words: string[]; placedCount: number; moveStats: MoveStats; eggs_found?: EggWord[] }
```
```sql
alter table profiles add eggs_found text[] not null default '{}';   -- self-read only, NOT in profiles_public
-- submit_game_summary(p_room_id uuid, p_profile uuid, p_summary jsonb) — unchanged signature; reads p_summary->'eggs_found'
-- _archive_game_impl — daily branch unlocks 'speedrun' when server duration < 60000 ms
```

- [ ] **Step 1: Write the failing tests.** Create `packages/shared/test/achievements.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ACHIEVEMENT_DEFS, ACHIEVEMENT_ORDER, achievementDisplay, type AchievementType } from '../src/index.js';

const MYSTERY: AchievementType[] = ['egg_hunter', 'mind_and_hand', 'practically_perfect', 'collector', 'speedrun'];

describe('mystery achievements', () => {
  it('all five exist, are hidden, carry a hint, and come after the standard nine', () => {
    for (const t of MYSTERY) {
      expect(ACHIEVEMENT_DEFS[t].hidden).toBe(true);
      expect(ACHIEVEMENT_DEFS[t].hint?.length ?? 0).toBeGreaterThan(0);
    }
    expect(ACHIEVEMENT_ORDER.slice(-5)).toEqual(MYSTERY);
    expect(ACHIEVEMENT_ORDER).toHaveLength(14);
  });

  it('uses the spec hints verbatim', () => {
    expect(ACHIEVEMENT_DEFS.egg_hunter.hint).toBe('Some words are more equal than others');
    expect(ACHIEVEMENT_DEFS.mind_and_hand.hint).toBe('Mind and hand');
    expect(ACHIEVEMENT_DEFS.practically_perfect.hint).toBe('Practically perfect');
    expect(ACHIEVEMENT_DEFS.collector.hint).toBe('Collector');
    expect(ACHIEVEMENT_DEFS.speedrun.hint).toBe('Speedrun');
  });

  it('a locked mystery achievement displays as ??? with its hint', () => {
    expect(achievementDisplay('mind_and_hand', false)).toEqual({
      title: '???',
      description: 'Mind and hand',
      mystery: true,
    });
  });

  it('an unlocked mystery achievement displays its real name', () => {
    const d = achievementDisplay('mind_and_hand', true);
    expect(d.mystery).toBe(false);
    expect(d.title).toBe(ACHIEVEMENT_DEFS.mind_and_hand.title);
    expect(d.title).not.toBe('???');
  });

  it('standard achievements are never masked, locked or not', () => {
    expect(achievementDisplay('speed_peeler', false)).toEqual({
      title: 'Speed Peeler',
      description: ACHIEVEMENT_DEFS.speed_peeler.description,
      mystery: false,
    });
  });
});
```

Add inside `describe('validateGameSummary', ...)` in `stats.test.ts`:

```ts
  it('accepts an optional eggs_found list of egg words', () => {
    expect(validateGameSummary({ ...good, eggs_found: ['MIT', 'GHOST'] })).toEqual({ valid: true });
  });

  it('rejects an eggs_found that is not a list of egg words', () => {
    expect(validateGameSummary({ ...good, eggs_found: ['NOPE'] })).toEqual({ valid: false, reason: 'MALFORMED' });
    expect(validateGameSummary({ ...good, eggs_found: 'MIT' })).toEqual({ valid: false, reason: 'MALFORMED' });
  });
```

Add above `const SECTIONS` in the smoke script:

```js
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
  const st = await one(`select longest_word from public.profile_stats where profile_id = $1 and mode = 'multiplayer'`, [me]);
  assert(st.longest_word === SUPERCALI, 'the 34-letter egg counts as a word in stats');

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
```

and append `sectionMysteryAchievements` to `SECTIONS`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --root packages/shared achievements stats` → Expected: FAIL — `achievementDisplay is not a function` / `expected undefined to be true` (no `hidden`), and the two new `eggs_found` cases fail (`eggs_found: ['NOPE']` currently returns `{ valid: true }`).
Run: `node scripts/smoke-easter-eggs.mjs mystery` → Expected: FAIL — `column "eggs_found" does not exist`.

- [ ] **Step 3a: Shared.** Replace `packages/shared/src/achievements.ts` with:

```ts
/** Achievement catalog — the single source of truth for DISPLAY (the locked/unlocked grid)
 * and for the `AchievementType` union shared by client + Worker. The unlock *evaluation*
 * lives in SQL (archive_game / submit_game_summary / supercali_win), where the game data is;
 * this file only describes them. Keep the string ids stable — they're persisted in
 * achievements.type.
 *
 * `hidden` achievements (Phase 4 "mystery" achievements) render as "???" with their `hint`
 * until unlocked, then by their real title/description — see achievementDisplay(). */

export type AchievementType =
  | 'speed_peeler'
  | 'marathon_mind'
  | 'no_dumps_given'
  | 'word_nerd'
  | 'alphabet_soup'
  | 'century_club'
  | 'peel_machine'
  | 'full_house'
  | 'nail_biter'
  | 'egg_hunter'
  | 'mind_and_hand'
  | 'practically_perfect'
  | 'collector'
  | 'speedrun';

export interface AchievementDef {
  title: string;
  description: string;
  /** Mystery achievement: shown as "???" + `hint` until unlocked. */
  hidden?: boolean;
  /** Vague clue shown on a locked hidden achievement. Required when `hidden`. */
  hint?: string;
}

/** Ordered for display (roughly easiest → rarest); mystery achievements last. */
export const ACHIEVEMENT_DEFS: Record<AchievementType, AchievementDef> = {
  speed_peeler: {
    title: 'Speed Peeler',
    description: 'Peel within 60 seconds of a Split.',
  },
  marathon_mind: {
    title: 'Marathon Mind',
    description: 'Win a game with 100 or more tiles in your grid.',
  },
  no_dumps_given: {
    title: 'No Dumps Given',
    description: 'Win a game without dumping a single tile.',
  },
  word_nerd: {
    title: 'Word Nerd',
    description: 'Play an especially rare word.',
  },
  alphabet_soup: {
    title: 'Alphabet Soup',
    description: 'Across all your games, play a word starting with every letter A–Z.',
  },
  century_club: {
    title: 'Century Club',
    description: 'Play 100 games.',
  },
  peel_machine: {
    title: 'Peel Machine',
    description: 'Peel 1,000 tiles across all your games.',
  },
  full_house: {
    title: 'Full House',
    description: 'Play a game with all 8 player slots filled.',
  },
  nail_biter: {
    title: 'Nail Biter',
    description: 'Win a game while an opponent has just one tile left to place.',
  },
  egg_hunter: {
    title: 'Egg Hunter',
    description: 'Play a hidden easter-egg word.',
    hidden: true,
    hint: 'Some words are more equal than others',
  },
  mind_and_hand: {
    title: 'Mens et Manus',
    description: 'Play MIT.',
    hidden: true,
    hint: 'Mind and hand',
  },
  practically_perfect: {
    title: 'Practically Perfect',
    description: 'Win instantly with SUPERCALIFRAGILISTICEXPIALIDOCIOUS.',
    hidden: true,
    hint: 'Practically perfect',
  },
  collector: {
    title: 'Egg Collector',
    description: 'Find every easter-egg word.',
    hidden: true,
    hint: 'Collector',
  },
  speedrun: {
    title: 'Speedrun',
    description: 'Solve the daily puzzle in under 60 seconds.',
    hidden: true,
    hint: 'Speedrun',
  },
};

/** All achievement ids in display order. */
export const ACHIEVEMENT_ORDER = Object.keys(ACHIEVEMENT_DEFS) as AchievementType[];

/** What a tile should show: a locked mystery achievement is "???" + its hint; everything else
 * (unlocked mystery included) shows its real title and description. */
export function achievementDisplay(
  type: AchievementType,
  unlocked: boolean,
): { title: string; description: string; mystery: boolean } {
  const def = ACHIEVEMENT_DEFS[type];
  if (def.hidden && !unlocked) return { title: '???', description: def.hint ?? '', mystery: true };
  return { title: def.title, description: def.description, mystery: false };
}
```

In `stats.ts` change the Task 7 import to `import { isEasterEggWord, sanitizeEggsFound, type EggWord } from './easterEggs.js';`, add to `GameSummary` after `moveStats: MoveStats;`:

```ts
  /** Easter-egg words this player had validly on their board at any point this game (Phase 4).
   * snake_case to match the spec and the SQL reader (p_summary -> 'eggs_found'). Spoofable —
   * accepted; re-filtered against _easter_egg_words() server-side. */
  eggs_found?: EggWord[];
```

and in `validateGameSummary`, immediately before the final `return { valid: true };`:

```ts
  if (s.eggs_found !== undefined && sanitizeEggsFound(s.eggs_found) === null) {
    return { valid: false, reason: 'MALFORMED' };
  }
```

- [ ] **Step 3b: Migration** — create `supabase/migrations/20261006000405_egg_achievements.sql`:

```sql
-- Phase 4 mystery achievements + cumulative egg tracking.
--
-- profiles.eggs_found: every egg word this account has ever found. Readable only by its owner
-- (the existing profiles_select_own policy) and deliberately NOT added to profiles_public.
-- Client-reported via the end-of-game summary (p_summary -> 'eggs_found', inside the EXISTING
-- jsonb param — no signature change) and re-filtered against _easter_egg_words() here.
-- Spoofable — accepted by the spec. A guest's list dies with the 10-day guest sweep like the rest
-- of their profile.
--
-- Unlocks: egg_hunter (any egg), mind_and_hand (MIT), collector (every egg in the list — grows
-- automatically with _easter_egg_words()) in submit_game_summary; speedrun (daily, server-measured
-- duration < 60 s) in _archive_game_impl. practically_perfect is unlocked in supercali_win
-- (20261006000404).

alter table public.profiles
  add column eggs_found text[] not null default '{}';

-- ---------------------------------------------------------------------------
-- submit_game_summary — verbatim from 20260808000002 plus the [phase4] lines.
-- ---------------------------------------------------------------------------
create or replace function public.submit_game_summary(
  p_room_id uuid, p_profile uuid, p_summary jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_rp public.room_players;
  v_words text[];
  v_invalid text[];
  v_valid_words text[];
  v_word_count int;
  v_total_len bigint;
  v_longest text;
  v_longest_len int;
  v_rarest text;
  v_rarest_score int;
  v_new_letters text;
  v_letter_tally jsonb;
  v_stat public.profile_stats;
  v_merged text;
  v_eggs text[];       -- [phase4]
  v_all_eggs text[];   -- [phase4]
begin
  select * into v_room from public.rooms where id = p_room_id;
  if not found then raise exception 'ROOM_NOT_FOUND' using errcode = 'P0002'; end if;

  if v_room.mode = 'xtina' then
    update public.room_players set summary_applied = true
      where room_id = p_room_id and profile_id = p_profile;
    return jsonb_build_object('ok', true, 'longestWord', null, 'rarestWord', null, 'wordCount', 0);
  end if;

  select * into v_rp from public.room_players
    where room_id = p_room_id and profile_id = p_profile
    for update;
  if not found then raise exception 'NOT_IN_ROOM' using errcode = 'P0002'; end if;

  -- [phase4] egg words are exempt from the 2-20 pattern (SUPERCALI… is 34 letters).
  select coalesce(array_agg(upper(w)), '{}') into v_words
    from jsonb_array_elements_text(coalesce(p_summary -> 'words', '[]'::jsonb)) w
    where upper(w) ~ '^[A-Z]{2,20}$' or upper(w) = any (public._easter_egg_words());

  -- [phase4] eggs found this game: uppercased, deduped, anything not in the egg list dropped.
  select coalesce(array_agg(distinct upper(e)), '{}') into v_eggs
    from jsonb_array_elements_text(
      case when jsonb_typeof(p_summary -> 'eggs_found') = 'array'
           then p_summary -> 'eggs_found' else '[]'::jsonb end
    ) e
    where upper(e) = any (public._easter_egg_words());

  -- Dictionary-filter before anything is counted: a losing player's final grid is whatever
  -- half-built state they were in, so without this a fragment like REDUND lands in their
  -- lifetime records as a real word. The room's own config is the right dictionary and it's
  -- guaranteed to still exist here (the summary arrives while the room is alive).
  v_invalid := public._find_invalid_words_cfg(coalesce(v_room.dictionary_config, '{}'::jsonb), v_words);
  select coalesce(array_agg(w), '{}') into v_valid_words
    from unnest(v_words) w
    where not (w = any(v_invalid));

  v_word_count := coalesce(array_length(v_valid_words, 1), 0);
  select coalesce(sum(char_length(x)), 0) into v_total_len from unnest(v_valid_words) x;

  select x into v_longest from unnest(v_valid_words) x order by char_length(x) desc, x limit 1;
  v_longest_len := coalesce(char_length(v_longest), 0);

  select x, public.word_rarity(x) into v_rarest, v_rarest_score
    from unnest(v_valid_words) x order by public.word_rarity(x) desc, x limit 1;
  v_rarest_score := coalesce(v_rarest_score, 0);

  select string_agg(distinct substr(x, 1, 1), '' order by substr(x, 1, 1))
    into v_new_letters from unnest(v_valid_words) x;
  v_new_letters := coalesce(v_new_letters, '');

  select coalesce(jsonb_object_agg(letter, cnt), '{}'::jsonb) into v_letter_tally
    from (
      select substr(x, 1, 1) as letter, count(*) as cnt
      from unnest(v_valid_words) x
      group by substr(x, 1, 1)
    ) g;

  if not v_rp.summary_applied then
    select * into v_stat from public.profile_stats
      where profile_id = p_profile and mode = v_room.mode;
    if not found then
      insert into public.profile_stats (profile_id, mode, updated_at)
      values (p_profile, v_room.mode, now());
      select * into v_stat from public.profile_stats
        where profile_id = p_profile and mode = v_room.mode;
    end if;

    select string_agg(c, '' order by c) into v_merged from (
      select distinct unnest(string_to_array(coalesce(v_stat.first_letters, '') || v_new_letters, null)) as c
    ) s where c ~ '^[A-Z]$';

    update public.profile_stats set
      total_words = v_stat.total_words + v_word_count,
      total_word_length = v_stat.total_word_length + v_total_len,
      longest_word = case when v_longest_len > v_stat.longest_word_length then v_longest else v_stat.longest_word end,
      longest_word_length = greatest(v_stat.longest_word_length, v_longest_len),
      rarest_word = case when v_rarest_score > v_stat.rarest_word_score then v_rarest else v_stat.rarest_word end,
      rarest_word_score = greatest(v_stat.rarest_word_score, v_rarest_score),
      first_letters = coalesce(v_merged, v_stat.first_letters),
      first_letter_counts = public._merge_letter_counts(v_stat.first_letter_counts, v_letter_tally),
      updated_at = now()
    where profile_id = p_profile and mode = v_room.mode;

    update public.room_players set summary_applied = true where id = v_rp.id;

    if exists (select 1 from unnest(v_valid_words) x where public.word_rarity(x) >= 30) then
      perform public._unlock_achievement(p_profile, 'word_nerd',
        jsonb_build_object('roomId', p_room_id, 'word', v_rarest, 'score', v_rarest_score));
    end if;
    if coalesce(char_length(v_merged), 0) >= 26 then
      perform public._unlock_achievement(p_profile, 'alphabet_soup', jsonb_build_object('roomId', p_room_id));
    end if;

    -- [phase4] cumulative eggs + mystery achievements. Inside the summary_applied guard, so a
    -- resubmitted summary for the same room is a no-op here too.
    if cardinality(v_eggs) > 0 then
      update public.profiles p set eggs_found = (
        select array_agg(distinct e order by e) from unnest(p.eggs_found || v_eggs) e
      )
      where p.id = p_profile
      returning p.eggs_found into v_all_eggs;

      perform public._unlock_achievement(p_profile, 'egg_hunter',
        jsonb_build_object('roomId', p_room_id, 'eggs', to_jsonb(v_eggs)));
      if 'MIT' = any (v_eggs) then
        perform public._unlock_achievement(p_profile, 'mind_and_hand', jsonb_build_object('roomId', p_room_id));
      end if;
      if public._easter_egg_words() <@ v_all_eggs then
        perform public._unlock_achievement(p_profile, 'collector', jsonb_build_object('roomId', p_room_id));
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'longestWord', v_longest,
    'rarestWord', v_rarest,
    'wordCount', v_word_count
  );
end;
$$;
```

Then, in the same file, the full `_archive_game_impl` from Task 6's `20261006000403_freeze_archive.sql` (copy that file's entire `create or replace function public._archive_game_impl ... $$;` statement verbatim — it is the latest definition), with exactly one change: replace its daily block

```sql
      update public.profile_stats set daily_best_time_ms = null
        where profile_id = v_p.profile_id and mode = 'daily' and daily_best_time_ms = 2147483647;
    end if;
```

with

```sql
      update public.profile_stats set daily_best_time_ms = null
        where profile_id = v_p.profile_id and mode = 'daily' and daily_best_time_ms = 2147483647;

      -- [phase4] Mystery achievement Speedrun: server-measured, so it can't be spoofed by a
      -- client clock (FREEZE never applies to daily).
      if v_duration_ms < 60000 then
        perform public._unlock_achievement(v_p.profile_id, 'speedrun',
          jsonb_build_object('roomId', p_room_id, 'ms', v_duration_ms));
      end if;
    end if;
```

and update the header comment of the copied function to read `-- _archive_game_impl: verbatim from 20261006000403 plus the [phase4] speedrun unlock.` Close the file with:

```sql
do $$
begin
  execute 'revoke all on function public._archive_game_impl(uuid,uuid) from public, anon, authenticated';
  execute 'grant execute on function public._archive_game_impl(uuid,uuid) to service_role';
end $$;
```

(`submit_game_summary`'s existing service_role-only grants survive `create or replace`.)

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:shared` → Expected: all PASS, including `achievements.test.ts` and the new `stats.test.ts` cases.
Run: `npm run build:shared; npx supabase migration up --local; node scripts/smoke-easter-eggs.mjs` → Expected: every section passes (`sectionMysteryAchievements` prints 14 `ok` lines), `ALL PASSED`. Also re-run `node scripts/smoke-daily-stats.mjs` and `node scripts/smoke-stats-tiles.mjs` → pass (regression on the copied bodies).

- [ ] **Step 5: Client.** `Game.tsx` `submitSummaryOnce` — replace the summary line with:

```ts
    // Words and move stats roll into lifetime profile stats and are then forgotten. eggs_found
    // feeds the Phase 4 mystery achievements (egg_hunter / mind_and_hand / collector).
    api
      .submitGameSummary(roomId, { ...moveTracker.buildSummary(gridRef.current), eggs_found: getFoundEggs() })
      .catch(() => {});
```

(remove the temporary `void getFoundEggs;` line from Task 4 if it was added.)

`Profile.tsx` — add `achievementDisplay,` to the shared import (keep `ACHIEVEMENT_ORDER`; drop `ACHIEVEMENT_DEFS` if it becomes unused) and replace the body of the `ACHIEVEMENT_ORDER.map` callback in `AchievementGrid` with:

```tsx
          const isUnlocked = unlocked.has(type);
          const shown = achievementDisplay(type, isUnlocked);
          return (
            <div
              key={type}
              className={`achievement-tile${isUnlocked ? ' unlocked' : ' locked'}${shown.mystery ? ' mystery' : ''}`}
            >
              <span className="achievement-status">{isUnlocked ? 'Unlocked' : 'Locked'}</span>
              <span className="achievement-title">{shown.title}</span>
              <span className="achievement-desc">{shown.description}</span>
            </div>
          );
```

`styles.css` — after `.achievement-desc { ... }`:

```css
/* Mystery achievement, still locked: "???" + a vague hint. */
.achievement-tile.mystery .achievement-title {
  letter-spacing: 0.2em;
}
.achievement-tile.mystery .achievement-desc {
  font-style: italic;
}
```

`Results.tsx` — the multiplayer/solo strip already renders `ACHIEVEMENT_DEFS[t].title` for every earned type, so a newly unlocked mystery achievement appears by its real name with no change (verify, don't edit). For **daily** (Phase 1.4 removed the achievement re-poll there and Phase 2 removed the section), add one read: next to the other daily state add

```ts
  // Mystery achievement Speedrun is unlocked server-side in archive_game, which completes before
  // game_over reaches anyone — so a single read is enough; no 400/1000ms re-poll (spec 1.4).
  const [speedrun, setSpeedrun] = useState(false);
  useEffect(() => {
    if (!roomId || room?.mode !== 'daily') return;
    let cancelled = false;
    fetchMyAchievements().then((rows) => {
      if (cancelled) return;
      setSpeedrun(rows.some((a) => a.type === 'speedrun' && (a.meta as { roomId?: string })?.roomId === roomId));
    });
    return () => {
      cancelled = true;
    };
  }, [roomId, room?.mode]);
```

(placed with the other hooks, before the `if (!room)` early return), and inside the daily "Your game" panel, directly after the nested share box, render:

```tsx
          {speedrun && (
            <p className="results-achievement daily-speedrun-unlocked">
              Achievement unlocked: {ACHIEVEMENT_DEFS.speedrun.title}
            </p>
          )}
```

This line appears only when earned (rare), at the bottom of the panel, so it shifts nothing above it; this is a deliberate, documented exception to spec 1.4's fixed-placeholder rule (a permanent placeholder would advertise the hidden achievement).

- [ ] **Step 6: Typecheck + browser check.** Run `npm run build:shared; npm run typecheck --workspace @plantain/web; npm run typecheck --workspace @plantain/api` → exit 0. Browser: get the tab user id (Task 3 snippet); `update public.profiles set is_guest = false where id = '<UID>'` (so the guest lock veil is absent), open `/profile` → Achievements. With `*{transition:none}` injected, evaluate `[...document.querySelectorAll('.achievement-tile.mystery')].map((t) => t.innerText)`: expected 5 tiles, each titled `???` with the five spec hints. Insert `insert into public.achievements (user_id, type, meta) values ('<UID>', 'mind_and_hand', '{}')`, reload: expected 4 mystery tiles and an unlocked `Mens et Manus` tile. Screenshot both. Restore `is_guest = true` and delete the inserted row. Record observations honestly.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/achievements.ts packages/shared/src/stats.ts packages/shared/test/achievements.test.ts packages/shared/test/stats.test.ts supabase/migrations/20261006000405_egg_achievements.sql scripts/smoke-easter-eggs.mjs apps/web/src/pages/Game.tsx apps/web/src/pages/Profile.tsx apps/web/src/pages/Results.tsx apps/web/src/styles.css
git commit -m "feat: mystery achievements and cumulative easter egg tracking

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Full local verification + prod migration handoff note

**Files:**
- Modify: `CLAUDE.md` (new dated status entry under "Current status"; add `supercali_win`, `report_egg_flags` to the RPC list in "Key files & functions to reuse"; add `easterEggs.ts` to the repo layout under `packages/shared/src`)

**Interfaces:** none.

- [ ] **Step 1: Clean-slate replay (the failing-first check for ordering).** Run: `npm run db:reset` then `npm run db:seed`, `npm run build:shared`, `node scripts/smoke-easter-eggs.mjs`.
Expected: migrations 20261006000401..000405 apply in filename order with no error and every smoke section passes. Any failure here is an ordering/dependency bug — fix it before continuing.

- [ ] **Step 2: Regression suite.** Run: `npm run test:shared`, `node scripts/smoke-daily-stats.mjs`, `node scripts/smoke-stats-tiles.mjs`, `node scripts/smoke-xtina.mjs`, `node scripts/smoke-guest-sweep.mjs`, `npm run typecheck --workspace @plantain/api`, `npm run typecheck --workspace @plantain/web`, `npm run build --workspace @plantain/web`.
Expected: all pass. (`smoke-xtina` matters: `start_game`/`peel` are untouched, but `rematch_room`, `room_players_public` and `_archive_game_impl` changed.)

- [ ] **Step 3: Update `CLAUDE.md`.** Add a `✅ **Easter eggs + mystery achievements (2026-10-06)**` status entry stating: the four eggs and their effects; the single-source-of-truth pair (`easterEggs.ts` ↔ `_easter_egg_words()`); that `_find_invalid_words_cfg` pre-filters eggs and its two-EXISTS shape is asserted by `scripts/smoke-easter-eggs.mjs`; that GHOST/FREEZE ride `POST /progress` → `report_egg_flags` (a dedicated RPC to avoid a `report_progress` overload); that `room_players_public` now masks counts for a ghosted player while `status = 'active'` (another reason that view's join/filters are load-bearing); that `supercali_win` bypasses the bunch-low gate and does not emit `game_over` (the Worker does, flagged `supercali: true`); that `profiles.eggs_found` is self-read only and NOT in `profiles_public`; and exactly which checks were verified live vs only by smoke/typecheck.

- [ ] **Step 4: Prod migration handoff note** (deliver to the user in chat; do NOT run against prod without their go-ahead):

> Run these five files against prod **in this exact order, one at a time**, by pasting each FILE's contents (not text from a chat — `$$` bodies get mangled) into the Supabase dashboard SQL editor:
> 1. `supabase/migrations/20261006000401_easter_egg_words.sql`
> 2. `supabase/migrations/20261006000402_egg_room_state.sql`
> 3. `supabase/migrations/20261006000403_freeze_archive.sql`
> 4. `supabase/migrations/20261006000404_supercali_win.sql`
> 5. `supabase/migrations/20261006000405_egg_achievements.sql`
>
> Run them BEFORE pushing the branch to `main`: the new Worker route calls `supercali_win` / `report_egg_flags`, and the web app reads `ghosted` / `win_kind`. (Old clients keep working against the new schema — every view change only appends columns, and the old `/progress` body `{ remaining }` is handled unchanged.) If one errors mentioning an object not in that file, check an earlier one wasn't skipped (CLAUDE.md, Deployment). Then sanity-check in the SQL editor: `select public._easter_egg_words();` returns the 4 words, and `select public._find_invalid_words_cfg('{"baseEnabled":false,"minLength":5}'::jsonb, array['MIT','CAT']);` returns `{CAT}`. Push to `main` afterwards (Worker deploys via GitHub Actions, web via Vercel).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record easter eggs + mystery achievements in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review against spec 4.1 / 4.2

| Spec bullet | Where | Notes |
|---|---|---|
| Egg words always valid, every dictionary/mode, regardless of config and length bounds | Task 2 | Smoke: en off + minLength 5 → MIT valid; maxLength 4 → 34-letter egg valid. |
| Public bundle is fine | Task 1 | Comment in `easterEggs.ts`. |
| MIT valid everywhere + maroon tint | Tasks 2, 3 | |
| SUPERCALI instantly wins (any mode) | Task 7 | Xtina excluded client-side only (the scripted board can't contain it); the RPC allows any mode, achievements skip xtina. |
| GHOST → "??" for the rest of the game, even if later broken | Task 5 | One-way latch; smoke asserts `{"ghosted": false}` cannot clear it. Mask lifts once the room is `finished` (spec: "rest of the game"). |
| FREEZE: Timed solo only, 10 s, once, first valid appearance; no effect elsewhere | Task 6 | Server ignores it outside Timed solo (smoke: Zen + multiplayer). |
| `easterEggs.ts` list + metadata; SQL `_easter_egg_words()` immutable twin, kept in sync | Tasks 1, 2 | Smoke asserts identical order. |
| Egg acceptance in `_find_invalid_words_cfg` as a separate short-circuit, not OR'd | Task 2 | `v_candidates` pre-filter; smoke asserts exactly two EXISTS remain. |
| Accepted in live `/validate` and Plantains/summary | Tasks 2, 7, 8 | Summary also needed the `^[A-Z]{2,20}$` exemption (Task 7 shared, Task 8 SQL) — a gap the spec missed: without it a Supercali winner's whole summary 400s. |
| Client verdict cache marks eggs valid locally without a request | Task 3 | `wordVerdictsRef` seeded. |
| Supercali 34 letters OK; pattern only for custom words | Tasks 1, 7 | Plus the summary-pattern exemption above. |
| `GameBoard` `board-tile egg-mit`, priority over `valid` (accent precedence pattern) | Task 3 | accent > egg-mit > valid. |
| Tokens `--color-tile-mit-bg`/`--color-tile-mit-border` + colorblind overrides | Task 3 | Plus `--color-tile-mit-text` for contrast. |
| Also in `BoardPreview` (Results/viewer) | Task 3 | `BoardWords.mitCells`; Results + BoardViewer pass it. |
| Client detects Supercali → `POST /rooms/:id/supercali` | Task 7 | |
| Worker relaxed structural check: sub-multiset, connected, no orphans, all words valid, contains word | Tasks 1, 7 | `validateSupercaliStructure` + `find_invalid_words`; SQL re-checks the structural half. |
| New `supercali_win` RPC, row-locked, caller wins, bypasses bunch-low gate | Task 7 | Smoke proves the bypass (bunch > 2 at win). |
| `game_over` flagged `supercali: true` | Task 7 | **Deliberate deviation:** emitted by the Worker after `archive_game`, not by the RPC — matches `finish_game`'s convention (20260719000006) so Results reads achievements that already exist. |
| Results special callout | Task 7 | `rooms.win_kind` (exposed on `rooms_public`) drives it, so a reload of Results still shows it; daily keeps its own header. |
| `room_players.ghosted default false`, set via `report_progress` path (new optional flag) | Task 5 | Same HTTP route (`/progress`); new dedicated RPC `report_egg_flags` instead of a new `report_progress` param, per CLAUDE.md's overload rule. |
| `room_players_public` nulls `tile_count`/`remaining_count` when ghosted; client "??" | Task 5 | |
| Cleared on `rematch_room` | Task 5 | Also clears `freeze_used`, `win_kind`. |
| FREEZE client pause in Timed solo ticker; reported as `freeze_used`; `archive_game` subtracts 10 000 ms | Task 6 | Results' elapsed tile subtracts too, so it matches the stored best time. |
| `useEasterEggs` fires each trigger once per game | Task 4 | Pure rule tested in Task 1; user-contribution candidate marked. |
| Hidden achievements, "???" + hint, real name after unlock | Task 8 | `achievementDisplay`; spec hints verbatim (tested). |
| egg_hunter / mind_and_hand / collector unlock conditions | Task 8 | `collector` uses `_easter_egg_words() <@ eggs_found`, so it grows with the list. |
| practically_perfect in `supercali_win` | Task 7 | |
| speedrun in daily archive from server duration < 60 s | Task 8 | Boundary (exactly 60 s) tested. |
| `submit_game_summary` accepts optional `eggs_found`, validated server-side | Task 8 | Shared `sanitizeEggsFound` (Worker 400s garbage) + SQL filter (defense in depth). |
| Persisted cumulatively in `profiles.eggs_found text[]`, self-read only, not in `profiles_public` | Task 8 | Smoke asserts both the cross-account read and `profiles_public` exclusion. |
| Existing guest lock applies unchanged | Task 8 | No change to `GuestGate`; the browser check flips `is_guest` only to see past the veil, then restores it. |
| Results strip shows a newly unlocked mystery achievement by real name | Task 8 | Existing strip already uses real titles; daily gets the single-read Speedrun line (spec 1.4). |
| Testing: vitest for `easterEggs.ts`; SQL smoke for restrictive config, supercali accept/reject, masking, FREEZE, each mystery unlock; browser MIT tint | Tasks 1-8 | Plus browser "???" tiles, GHOST two-tab, FREEZE clock, Supercali callout. |
| Migrations run locally in filename order before prod | Task 9 | Clean `db:reset` replay. |

Known seams (accepted, documented): eggs and FREEZE are client-reported and spoofable (spec says accepted); a reload during a FREEZE re-pauses the local display while the server subtracts only once; with word validation turned off in settings, eggs are detected on presence alone (Supercali is still fully re-validated by the Worker) and MIT does not tint (nothing is validated in that mode).
