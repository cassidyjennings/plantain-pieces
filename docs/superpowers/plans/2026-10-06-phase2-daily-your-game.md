# Phase 2 Daily "Your game" Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the daily-puzzle Results page's scattered "Your game" bits (streak pill, beat-percent
pill, "Be the first" pill, loose "New personal best!" line, separate share card) with one
`.panel.results-earned` holding a 2x2 `.stat-tile` grid (Longest word, Time + "Personal Best" corner
badge, Day streak, Solvers beaten) and a darker nested "Share your result" box. This is mockup C
from the spec.

**Architecture:** The pure display logic (duration formatting, the "64%" / "First!" / loading
mapping for Solvers beaten, the personal-best check) goes into a new `packages/shared/src/dailyResults.ts`
with vitest coverage, because `apps/web` has no test runner. A new presentational component,
`apps/web/src/components/DailyYourGame.tsx`, renders the daily panel and owns the copy-to-clipboard
state. `Results.tsx` keeps every fetch. It gains two "settled" flags so tiles can tell "still loading"
apart from "loaded, nothing to show". It renders `<DailyYourGame>` straight after the header, and the
solo/multiplayer panels become explicitly `!isDaily`. The daily panel no longer waits for `me`
(`fetchPlayers`): none of its four values come from it. Styling reuses `.stat-tile` and adds two
tokens, `--color-surface-sunken` and `--font-mono`.

**Tech Stack:** React 18 + TypeScript + Vite (`apps/web`), vitest (`packages/shared`), plain CSS with
design tokens (`apps/web/src/styles/tokens.css`, `apps/web/src/styles.css`), `pg` (Node) for a local
fixture script, Claude Browser pane (`preview_start`) for visual verification.

## Global Constraints

- npm workspaces, NOT pnpm. Use `npm` for everything.
- Windows: PowerShell / Git Bash. Use absolute paths, and no inline `VAR=x cmd` in PowerShell.
- Verification honesty: typecheck/build passing is NEVER proof a UI change works. Every visual claim needs a browser measurement or screenshot.
- Before reading computed styles in the Claude Browser pane, inject `*{transition:none!important;animation:none!important}`.
- `resize_window` is unreliable for overflow testing. Use a fixed-width wrapper or pin the element's width in JS and measure `getBoundingClientRect()`.
- Use design tokens from `apps/web/src/styles/tokens.css`, never raw colour values in component rules.
- Any button with a visible "on" state gets `.toggle-btn`. The Copy button here is a momentary action, not a toggle, so it does NOT get it.
- A component `:hover` rule that changes `background` must also restate `color` if another rule can set a contrasting `color`.
- Share text content stays unchanged. It is built in `Results.tsx` (currently :236-248).
- Header ("Solved!" + date) and the "Your board" window stay unchanged.
- Phase 1 (spec 1.4) runs first and edits `Results.tsx` fetch effects and placeholders. Match edits by the quoted code, not by line numbers, and keep Phase 1's non-daily behaviour wherever the two touch.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Spec: `docs/superpowers/specs/2026-10-06-polish-solo-batches-easter-eggs-design.md`, "Phase 2".

---

### Task 1: Pure helpers for the daily tiles (`packages/shared`)

**Files:**
- Create: `packages/shared/src/dailyResults.ts`
- Create: `packages/shared/test/dailyResults.test.ts`
- Modify: `packages/shared/src/index.ts:11` (append one export line after `export * from './xtina.js';`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface DailySummaryLike { available: boolean; beatPercent?: number | null; isPersonalBest?: boolean }`. `apps/web`'s `DailyResultSummary` (`apps/web/src/lib/api.ts:83-89`) matches it structurally.
  - `export function formatDurationMs(ms: number): string`. Returns `"M:SS"`, the same format the Results Time tile already shows.
  - `export function solversBeatenLabel(summary: DailySummaryLike | null, settled: boolean): string | null`. Returns `null` while loading (the caller renders a skeleton), `"First!"` for the first solver, `"64%"` otherwise, and `"-"` if the summary never arrives.
  - `export function isDailyPersonalBest(summary: DailySummaryLike | null): boolean`

Semantics come from `supabase/migrations/20260924000004_daily_result_summary_rpc.sql`:
- `available: false` means this player's `daily_results` row hasn't been written yet. `archive_game` runs async right after the game, which is why Results retries at 1000ms.
- `beatPercent` is `null` exactly when `v_total <= 1`, i.e. this player is the only solver so far. That case is "First!".

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/dailyResults.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatDurationMs, solversBeatenLabel, isDailyPersonalBest } from '../src/index.js';

describe('formatDurationMs', () => {
  it('formats minutes and zero-padded seconds', () => {
    expect(formatDurationMs(123_000)).toBe('2:03');
    expect(formatDurationMs(600_000)).toBe('10:00');
  });

  it('floors partial seconds, matching the old inline Results formatting', () => {
    expect(formatDurationMs(59_999)).toBe('0:59');
    expect(formatDurationMs(0)).toBe('0:00');
  });
});

describe('solversBeatenLabel', () => {
  it('is null (skeleton) before any summary has arrived', () => {
    expect(solversBeatenLabel(null, false)).toBeNull();
  });

  it('stays null while the archive row is not written yet and a retry is still pending', () => {
    expect(solversBeatenLabel({ available: false }, false)).toBeNull();
  });

  it('shows a percentage when other solvers exist', () => {
    expect(solversBeatenLabel({ available: true, beatPercent: 64 }, false)).toBe('64%');
    expect(solversBeatenLabel({ available: true, beatPercent: 0 }, true)).toBe('0%');
  });

  it('shows "First!" when this player is the only solver (beatPercent null)', () => {
    expect(solversBeatenLabel({ available: true, beatPercent: null }, true)).toBe('First!');
    expect(solversBeatenLabel({ available: true }, false)).toBe('First!');
  });

  it('falls back to "-" once the final attempt settled without a usable summary', () => {
    expect(solversBeatenLabel(null, true)).toBe('-');
    expect(solversBeatenLabel({ available: false }, true)).toBe('-');
  });
});

describe('isDailyPersonalBest', () => {
  it('is true only for an available summary flagged as a personal best', () => {
    expect(isDailyPersonalBest({ available: true, isPersonalBest: true })).toBe(true);
    expect(isDailyPersonalBest({ available: true, isPersonalBest: false })).toBe(false);
    expect(isDailyPersonalBest({ available: true })).toBe(false);
    expect(isDailyPersonalBest({ available: false, isPersonalBest: true })).toBe(false);
    expect(isDailyPersonalBest(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm run test:shared -- dailyResults`
Expected: FAIL. Either the import errors, or all three functions are `undefined` (`TypeError: ... is not a function`), because `dailyResults.ts` doesn't exist and isn't exported yet.

- [ ] **Step 3: Minimal implementation**

Create `packages/shared/src/dailyResults.ts`:

```ts
/**
 * Display logic for the daily puzzle's Results "Your game" tiles. Kept pure (and here, rather
 * than in apps/web) so it is unit-tested; apps/web has no test runner.
 */

/** The fields of the Worker's `/daily/:puzzleId/result-summary` reply these helpers read. */
export interface DailySummaryLike {
  available: boolean;
  beatPercent?: number | null;
  isPersonalBest?: boolean;
}

/** `ms` as `M:SS`, seconds floored. */
export function formatDurationMs(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * The Solvers beaten tile's value, or `null` while it should still show a skeleton.
 *
 * `available: false` means this player's daily_results row isn't written yet (archive_game runs
 * async after the game), so it keeps the skeleton until the caller's final retry has `settled`.
 * `beatPercent` is null exactly when this player is the only solver so far.
 */
export function solversBeatenLabel(summary: DailySummaryLike | null, settled: boolean): string | null {
  if (summary?.available) {
    return summary.beatPercent == null ? 'First!' : `${summary.beatPercent}%`;
  }
  return settled ? '-' : null;
}

/** Whether the Time tile carries the "Personal Best" badge. */
export function isDailyPersonalBest(summary: DailySummaryLike | null): boolean {
  return summary?.available === true && summary.isPersonalBest === true;
}
```

Edit `packages/shared/src/index.ts` and append after the last line (`export * from './xtina.js';`):

```ts
export * from './dailyResults.js';
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm run test:shared`
Expected: PASS. The new `dailyResults.test.ts` passes (4 describe blocks, 8 tests) and every existing test still passes.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/dailyResults.ts packages/shared/test/dailyResults.test.ts packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
feat(shared): daily Results tile helpers (duration, solvers beaten, personal best)

Pure, tested display logic for the Phase 2 daily "Your game" panel: "First!" when
the player is the only solver, a skeleton until the summary's final retry settles.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Local fixture, a finished daily room for the live browser tab

Every later browser check needs a finished daily room that belongs to the browser tab's own guest.
Solving a real daily through the UI each time isn't practical. This script builds one against the
LOCAL stack, using the same SQL entry points `scripts/smoke-daily-stats.mjs` already relies on.

**Files:**
- Create: `scripts/fixture-daily-results.mjs`

**Interfaces:**
- Consumes:
  - `public.create_daily_room(p_host uuid, p_display_name text, p_date date)`, which returns `{ roomId, code, seat, puzzleId, scheduledDate }` (`supabase/migrations/20260911000002_daily_local_date.sql:101-106`). It accepts only UTC today ±1 and needs a `status = 'scheduled'` puzzle for that date.
  - `public.archive_game(p_room_id uuid, p_winner uuid)`, which writes `daily_results` and `profile_stats.daily_best_time_ms`.
  - `public.get_daily_result_summary`, read indirectly through the Worker by the page.
- Produces: CLI `node scripts/fixture-daily-results.mjs --profile=<uuid> --date=YYYY-MM-DD [--others=N] [--no-pb] [--ms=123000]`. It prints one JSON line: `{"roomId": "...", "path": "/room/<id>/results", "expect": {...}}`.

- [ ] **Step 1: Run the not-yet-existing script and confirm it fails**

Run: `node scripts/fixture-daily-results.mjs --profile=00000000-0000-0000-0000-000000000000 --date=2026-10-06`
Expected: FAIL with `Error: Cannot find module '...scripts/fixture-daily-results.mjs'`.

- [ ] **Step 2: Implement the script**

Create `scripts/fixture-daily-results.mjs`:

```js
// scripts/fixture-daily-results.mjs
// Builds a FINISHED daily-puzzle room owned by the given profile, against the LOCAL stack only, so
// the daily Results page can be checked in the browser without solving a puzzle by hand.
//
//   node scripts/fixture-daily-results.mjs --profile=<uuid> --date=YYYY-MM-DD [--others=3] [--no-pb] [--ms=123000]
//
// --profile  the browser tab's own guest id (anonymous auth is per-tab, so never guess "newest guest")
// --date     the tab's LOCAL date; create_daily_room accepts UTC today +-1
// --others   other solvers to seed for this puzzle (default 3 -> 2 slower, 1 faster = "67%").
//            0 deletes every other daily_results row for the puzzle -> "First!" (local data only).
// --no-pb    pre-seeds a faster personal best (60s) so the "Personal Best" badge must NOT show
// --ms       this solve's duration (default 123000 = "2:03")
import pg from 'pg';

const DB = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB)) {
  console.error('Refusing to run: this fixture writes test rows and only targets the LOCAL stack.');
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);
const profileId = args.profile;
const date = args.date;
const others = Number(args.others ?? 3);
const noPb = args['no-pb'] === 'true';
const durationMs = Number(args.ms ?? 123000);
if (!profileId || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !Number.isInteger(others) || others < 0) {
  console.error(
    'usage: node scripts/fixture-daily-results.mjs --profile=<uuid> --date=YYYY-MM-DD [--others=3] [--no-pb] [--ms=123000]',
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: DB });

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

  // Prefer a real scheduled puzzle for that date; otherwise make a TEST one (first_word = 'TEST' is
  // the same cleanup marker scripts/smoke-daily-stats.mjs uses).
  let puzzle = (
    await client.query(
      `select id from public.daily_puzzles
        where status = 'scheduled' and scheduled_date = $1::date and language = 'en' limit 1`,
      [date],
    )
  ).rows[0];
  if (!puzzle) {
    puzzle = (
      await client.query(
        `insert into public.daily_puzzles
           (language, letter_multiset, grid_state, dictionary_config, floor_score, spread_score,
            distinct_board_count, replay_run_count, status, scheduled_date, generation_seed, first_word)
         values ('en', 'AELPST', '{}'::jsonb,
                 '{"minLength":2,"maxLength":null,"baseEnabled":true,"excludedTopics":[],"customSetIds":[]}'::jsonb,
                 1.0, 0.5, 1, 1, 'scheduled', $1::date, 1, 'TEST')
         returning id`,
        [date],
      )
    ).rows[0];
  }

  // Idempotent reruns: daily_results is unique per (puzzle, profile).
  await client.query(`delete from public.daily_results where puzzle_id = $1 and profile_id = $2`, [
    puzzle.id,
    profileId,
  ]);
  if (others === 0) {
    await client.query(`delete from public.daily_results where puzzle_id = $1`, [puzzle.id]);
  }

  // Personal best: archive_game sets daily_best_time_ms = least(existing, this run). Clearing it
  // makes this run the best (badge shows); seeding 60s first makes this run slower (no badge).
  await client.query(
    `insert into public.profile_stats (profile_id, mode, daily_best_time_ms)
       values ($1, 'daily', $2)
     on conflict (profile_id, mode) do update set daily_best_time_ms = excluded.daily_best_time_ms`,
    [profileId, noPb ? 60000 : null],
  );

  const room = (
    await client.query(`select public.create_daily_room($1, 'Fixture Tester', $2::date) as r`, [
      profileId,
      date,
    ])
  ).rows[0].r;
  const roomId = room.roomId;

  // PLATES across row 20: a valid word, so the Longest word tile has something to show.
  const grid = { '20,20': 'P', '21,20': 'L', '22,20': 'A', '23,20': 'T', '24,20': 'E', '25,20': 'S' };
  await client.query(
    `update public.room_players set grid_state = $1::jsonb where room_id = $2 and profile_id = $3`,
    [JSON.stringify(grid), roomId, profileId],
  );
  await client.query(
    `update public.rooms
        set status = 'finished',
            started_at = now() - ($1 || ' milliseconds')::interval,
            finished_at = now(),
            winner_id = $2
      where id = $3`,
    [durationMs, profileId, roomId],
  );

  for (let i = 0; i < others; i++) {
    const other = await makeUser(`fixture-daily-${Date.now()}-${i}@example.test`);
    const ms = i % 3 === 2 ? Math.max(1000, durationMs - 23000) : durationMs + 60000 * (i + 1);
    await client.query(
      `insert into public.daily_results (puzzle_id, profile_id, duration_ms) values ($1, $2, $3)`,
      [puzzle.id, other, ms],
    );
  }

  await client.query(`select public.archive_game($1, $2)`, [roomId, profileId]);

  const { rows: cmp } = await client.query(
    `select count(*)::int as total,
            count(*) filter (where profile_id <> $2 and duration_ms > $3)::int as slower
       from public.daily_results where puzzle_id = $1`,
    [puzzle.id, profileId, durationMs],
  );
  const { total, slower } = cmp[0];
  const beat = total > 1 ? `${Math.round((slower / (total - 1)) * 100)}%` : 'First!';
  console.log(
    JSON.stringify({
      roomId,
      path: `/room/${roomId}/results`,
      expect: { time: `${Math.floor(durationMs / 60000)}:${String(Math.floor((durationMs % 60000) / 1000)).padStart(2, '0')}`, solversBeaten: beat, personalBest: !noPb },
    }),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => client.end());
```

- [ ] **Step 3: Run it against the local stack and confirm it passes**

Run (Docker Desktop must be running):

```bash
npm run db:start
node scripts/fixture-daily-results.mjs --profile=$(node -e "const pg=require('pg');const c=new pg.Client('postgresql://postgres:postgres@127.0.0.1:54322/postgres');c.connect().then(()=>c.query(\"select id from public.profiles where is_guest order by created_at desc limit 1\")).then(r=>{console.log(r.rows[0].id);return c.end()})") --date=$(date +%F)
```

Expected: exit code 0 and one JSON line like
`{"roomId":"<uuid>","path":"/room/<uuid>/results","expect":{"time":"2:03","solversBeaten":"67%","personalBest":true}}`.
This run is ONLY a script smoke test. The browser tasks below always pass the live tab's own id, never "newest guest".
If you get `NO_DAILY_PUZZLE` or `INVALID_DAILY_DATE`, the date is outside UTC today ±1. Use `date -u +%F`.

- [ ] **Step 4: Commit**

```bash
git add scripts/fixture-daily-results.mjs
git commit -m "$(cat <<'EOF'
chore(scripts): local fixture for a finished daily Results room

Builds a finished daily room for a given profile (seeded solvers, optional faster
personal best) so the daily Results page can be browser-verified without solving
a puzzle by hand. Refuses to run against anything but 127.0.0.1/localhost.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `DailyYourGame` component and Results wiring (markup and state)

**Files:**
- Create: `apps/web/src/components/DailyYourGame.tsx`
- Modify: `apps/web/src/pages/Results.tsx`. Pre-Phase-1 line refs:
  - imports :11
  - state :33-35
  - board effect :98-115
  - summary effect :146-157
  - share text :244
  - `handleShare` :250-259
  - streak pill :275-279
  - skeleton + real panel :281-383
  - share card :415-424

**Interfaces:**
- Consumes:
  - `formatDurationMs`, `solversBeatenLabel` and `isDailyPersonalBest` from `@plantain/shared` (Task 1)
  - `DailyResultSummary` from `apps/web/src/lib/api.ts:83`
- Produces: the default export
  `DailyYourGame(props: { longestWord: string | null; longestWordReady: boolean; durationMs: number | null; streak: number | null; summary: DailyResultSummary | null; summarySettled: boolean; shareText: string }): JSX.Element`.
  It renders, in order:
  - `.panel.results-earned.daily-your-game` > `h3` "Your game"
  - `.daily-stat-grid` > 4 × `.stat-tile.daily-stat-tile`
  - `section.daily-share-box`, containing `.daily-share-head` (`h4.daily-share-title` + `button.daily-share-copy`) and `pre.daily-share-text`

- [ ] **Step 1: Write the failing browser test (old markup is still present)**

Start the stack and both dev servers:
1. Run `npm run db:start` in Bash.
2. Call `preview_start` with `name: "api"`, then `preview_start` with `name: "web"` (names from `.claude/launch.json`).
3. `navigate` to the web server's root URL so the tab mints a guest.
4. Run this with `javascript_tool` to read the tab's own guest id and local date:

```js
(() => {
  const read = (store) => {
    const k = Object.keys(store).find((key) => /^sb-.*-auth-token$/.test(key));
    return k ? JSON.parse(store.getItem(k)) : null;
  };
  const s = read(sessionStorage) ?? read(localStorage);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return { profileId: s?.user?.id, date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` };
})()
```

In Bash, run `node scripts/fixture-daily-results.mjs --profile=<profileId> --date=<date> --others=3`. Then `navigate` to `<web root>` + the printed `path`, and run:

```js
(() => {
  const panel = document.querySelector('.panel.results-earned');
  return {
    hasDailyComponent: !!document.querySelector('.daily-your-game'),
    tileLabels: [...document.querySelectorAll('.daily-stat-grid > .stat-tile .stat-label')].map((e) => e.textContent),
    shareBoxInPanel: !!panel?.querySelector('.daily-share-box'),
    streakPill: !!document.querySelector('.daily-streak-update'),
    oldShareCard: !!document.querySelector('.daily-share-card'),
    pbLine: !!document.querySelector('.daily-personal-best'),
    achievements: !!document.querySelector('.results-achievements'),
  };
})()
```

- [ ] **Step 2: Confirm the test fails against the current code**

Expected (FAIL against the target):
`hasDailyComponent: false`, `tileLabels: []`, `shareBoxInPanel: false`, `streakPill: true`, `oldShareCard: true`.
The target is `true`, `["Longest word","Time","Day streak","Solvers beaten"]`, `true`, `false`, `false`, with `pbLine: false` and `achievements: false`.

- [ ] **Step 3: Create the component**

Create `apps/web/src/components/DailyYourGame.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { formatDurationMs, isDailyPersonalBest, solversBeatenLabel } from '@plantain/shared';
import type { DailyResultSummary } from '../lib/api.js';

export interface DailyYourGameProps {
  longestWord: string | null;
  /** False while the board's words are still resolving: null `longestWord` alone can't tell
   *  "loading" from "no words". */
  longestWordReady: boolean;
  durationMs: number | null;
  /** null until the solve has been recorded into the local streak. */
  streak: number | null;
  summary: DailyResultSummary | null;
  /** True once the last scheduled summary attempt has landed or failed. */
  summarySettled: boolean;
  shareText: string;
}

/** `value === null` renders a skeleton bar in the value's line, so the tile is already its final
 *  size and nothing shifts when the number lands. */
function DailyStatTile({ label, value, badge }: { label: string; value: string | null; badge?: string | null }) {
  return (
    <div className="stat-tile daily-stat-tile" aria-busy={value === null}>
      {badge && <span className="daily-pb-badge">{badge}</span>}
      <span className="stat-value">{value ?? <span className="skeleton-bar" aria-hidden="true" />}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

/** The daily puzzle's Results "Your game" panel: a 2x2 tile grid plus the nested share box. */
export default function DailyYourGame({
  longestWord,
  longestWordReady,
  durationMs,
  streak,
  summary,
  summarySettled,
  shareText,
}: DailyYourGameProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  async function handleCopy() {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <div className="panel results-earned daily-your-game">
      <h3>Your game</h3>
      <div className="daily-stat-grid">
        <DailyStatTile label="Longest word" value={longestWordReady ? (longestWord ?? '-') : null} />
        <DailyStatTile
          label="Time"
          value={durationMs != null ? formatDurationMs(durationMs) : '-'}
          badge={isDailyPersonalBest(summary) ? 'Personal Best' : null}
        />
        <DailyStatTile label="Day streak" value={streak == null ? null : String(streak)} />
        <DailyStatTile label="Solvers beaten" value={solversBeatenLabel(summary, summarySettled)} />
      </div>
      <section className="daily-share-box" aria-labelledby="daily-share-heading">
        <div className="daily-share-head">
          <h4 id="daily-share-heading" className="daily-share-title">
            Share your result
          </h4>
          <button type="button" className="daily-share-copy" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <pre className="daily-share-text">{shareText}</pre>
        {copyFailed && <p className="error">Couldn't copy automatically. Select the text above instead.</p>}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Wire `Results.tsx`, import**

Replace:

```tsx
import BoardPreview from '../components/BoardPreview.js';
```

with:

```tsx
import BoardPreview from '../components/BoardPreview.js';
import DailyYourGame from '../components/DailyYourGame.js';
```

- [ ] **Step 5: Wire `Results.tsx`, state**

Replace:

```tsx
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [streak, setStreak] = useState(0);
```

with:

```tsx
  // null until the solve is recorded below, so the Day streak tile shows a skeleton instead of
  // flashing 0 for a render.
  const [streak, setStreak] = useState<number | null>(null);
  // longestWord === null means both "not loaded yet" and "no words"; only the first is a skeleton.
  const [longestWordReady, setLongestWordReady] = useState(false);
  // True once the LAST scheduled summary attempt lands or fails, so an early `available: false`
  // (archive_game not written yet) keeps the skeleton instead of flashing "-".
  const [dailySummarySettled, setDailySummarySettled] = useState(false);
```

- [ ] **Step 6: Wire `Results.tsx`, board effect settles the Longest word tile**

Replace (inside the `fetchRoomBoards` effect):

```tsx
    async function load() {
      const seq = ++latestSeq;
      const rows = await fetchRoomBoards(roomId!);
      if (cancelled || seq !== latestSeq) return;
      setBoardCount(rows.length);
      const mine = rows.find((r) => r.profile_id === profileId) ?? null;
      setMyBoard(mine);
      // Longest word is derived from the board rather than read back from a stored record.
      if (mine) {
        const { words } = await resolveBoardWords(roomId!, mine.grid_state);
        if (cancelled || seq !== latestSeq) return;
        setLongestWord(
          words.reduce<string | null>((best, w) => (!best || w.length > best.length ? w : best), null),
        );
      }
    }
    load();
    const t = setTimeout(load, 1000);
```

with:

```tsx
    async function load(isFinal: boolean) {
      const seq = ++latestSeq;
      try {
        const rows = await fetchRoomBoards(roomId!);
        if (cancelled || seq !== latestSeq) return;
        setBoardCount(rows.length);
        const mine = rows.find((r) => r.profile_id === profileId) ?? null;
        setMyBoard(mine);
        // Longest word is derived from the board rather than read back from a stored record.
        if (mine) {
          const { words } = await resolveBoardWords(roomId!, mine.grid_state);
          if (cancelled || seq !== latestSeq) return;
          setLongestWord(
            words.reduce<string | null>((best, w) => (!best || w.length > best.length ? w : best), null),
          );
          setLongestWordReady(true);
        }
      } finally {
        // The last retry settles the tile either way, so a board that never arrived (or whose
        // words failed to resolve) shows "-" rather than an endless skeleton.
        if (isFinal && !cancelled) setLongestWordReady(true);
      }
    }
    load(false);
    const t = setTimeout(() => load(true), 1000);
```

Phase 1 note: if Phase 1 has already merged this effect into a parallel loader, make the same change
semantically. Set `longestWordReady` true once words resolve, and in a `finally` on the last retry.

- [ ] **Step 7: Wire `Results.tsx`, summary effect settles the Solvers beaten tile**

Replace (inside the `getDailyResultSummary` effect):

```tsx
    const puzzleId = (room.mode_config as { puzzleId?: string }).puzzleId;
    if (!puzzleId) return;
    let cancelled = false;
    let latestSeq = 0;
    async function load() {
      const seq = ++latestSeq;
      const summary = await api.getDailyResultSummary(puzzleId!);
      if (cancelled || seq !== latestSeq) return;
      setDailySummary(summary);
    }
    load();
    const t = setTimeout(load, 1000);
```

with:

```tsx
    const puzzleId = (room.mode_config as { puzzleId?: string }).puzzleId;
    if (!puzzleId) {
      setDailySummarySettled(true);
      return;
    }
    let cancelled = false;
    let latestSeq = 0;
    async function load(isFinal: boolean) {
      const seq = ++latestSeq;
      try {
        const summary = await api.getDailyResultSummary(puzzleId!);
        if (cancelled || seq !== latestSeq) return;
        setDailySummary(summary);
      } catch {
        // A failed attempt keeps whatever an earlier one returned; the final one settles below.
      } finally {
        if (isFinal && !cancelled) setDailySummarySettled(true);
      }
    }
    load(false);
    const t = setTimeout(() => load(true), 1000);
```

Phase 1 note: same as Step 6. If Phase 1 changed how this effect is scheduled, keep its scheduling
and add the `isFinal` → `setDailySummarySettled(true)` `finally`.

- [ ] **Step 8: Wire `Results.tsx`, share text null-safe streak, drop `handleShare`**

In the `shareText` array, replace:

```tsx
    streak > 0 ? `🔥 ${streak}-day streak` : '',
```

with:

```tsx
    streak != null && streak > 0 ? `🔥 ${streak}-day streak` : '',
```

The output is identical. Then delete the whole function, because copying now lives in `DailyYourGame`:

```tsx
  async function handleShare() {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
    }
  }
```

- [ ] **Step 9: Wire `Results.tsx`, render `DailyYourGame` and make the other panels non-daily**

Replace everything from the streak pill through the end of the real panel. That is the old JSX below,
starting at `{isDaily && streak > 0 && (` and ending with the `)}` just before
`{/* The board window: ...`:

```tsx
      {isDaily && streak > 0 && (
        <div className="daily-streak-update">
          🔥 {streak}-day streak!
        </div>
      )}

      {/* Skeleton mirrors the real panel's tile layout (same conditionals, no values yet) so
          when `me` lands the content fills in place instead of a new box appearing below. */}
      {!me && (
        <div className="panel results-earned" aria-hidden="true">
          <h3>Your game</h3>
          <div className="results-stat-row">
            {!isSolo && !isDaily && (
              <div className="stat-tile">
                <span className="stat-value"><span className="skeleton-bar" /></span>
                <span className="stat-label">Result</span>
              </div>
            )}
            {!isDaily && (
              <div className="stat-tile">
                <span className="stat-value"><span className="skeleton-bar" /></span>
                <span className="stat-label">Tiles</span>
              </div>
            )}
            <div className="stat-tile">
              <span className="stat-value"><span className="skeleton-bar" /></span>
              <span className="stat-label">Longest word</span>
            </div>
            {(isTimed || isDaily) && durationMs != null && (
              <div className="stat-tile">
                <span className="stat-value"><span className="skeleton-bar" /></span>
                <span className="stat-label">Time</span>
              </div>
            )}
          </div>
        </div>
      )}

      {me && (
        <div className="panel results-earned">
          <h3>Your game</h3>
          <div className="results-stat-row">
            {!isSolo && !isDaily && (
              <div className="stat-tile">
                <span className="stat-value">{won ? 'Win' : 'Loss'}</span>
                <span className="stat-label">Result</span>
              </div>
            )}
            {!isDaily && (
              <div className="stat-tile">
                <span className="stat-value">{me.tile_count}</span>
                <span className="stat-label">Tiles</span>
              </div>
            )}
            <div className="stat-tile">
              <span className="stat-value">{longestWord ?? '-'}</span>
              <span className="stat-label">Longest word</span>
            </div>
            {(isTimed || isDaily) && durationMs != null && (
              <div className="stat-tile">
                <span className="stat-value">
                  {Math.floor(durationMs / 60000)}:
                  {Math.floor((durationMs % 60000) / 1000).toString().padStart(2, '0')}
                </span>
                <span className="stat-label">Time</span>
              </div>
            )}
          </div>
          {earned.length === 0 && !achievementsSettled && (
            <div className="results-achievements" aria-hidden="true">
              <span className="results-achievements-label">
                Checking achievements… <span className="skeleton-bar" />
              </span>
            </div>
          )}
          {earned.length > 0 && (
            <div className="results-achievements">
              <span className="results-achievements-label">Achievements unlocked</span>
              <div className="results-achievement-icons">
                {earned.map((t) => (
                  <span key={t} className="results-achievement" title={ACHIEVEMENT_DEFS[t].description}>
                    {ACHIEVEMENT_DEFS[t].title}
                  </span>
                ))}
              </div>
            </div>
          )}
          {isDaily && (
            <div className="daily-beat-percent">
              {!dailySummary && (
                <span className="results-achievements-label">
                  Checking today's rankings… <span className="skeleton-bar" />
                </span>
              )}
              {dailySummary?.available && dailySummary.beatPercent != null && (
                <span className="daily-streak-update">
                  Beat {dailySummary.beatPercent}% of today's players
                </span>
              )}
              {dailySummary?.available && dailySummary.beatPercent == null && (
                <span className="daily-streak-update">Be the first to solve today!</span>
              )}
              {dailySummary?.isPersonalBest && (
                <span className="daily-personal-best">New personal best!</span>
              )}
            </div>
          )}
        </div>
      )}
```

with:

```tsx
      {/* Daily never waits on `me`: none of its four tiles come from fetchPlayers, and each tile
          holds its own skeleton until its value lands. */}
      {isDaily && (
        <DailyYourGame
          longestWord={longestWord}
          longestWordReady={longestWordReady}
          durationMs={durationMs}
          streak={streak}
          summary={dailySummary}
          summarySettled={dailySummarySettled}
          shareText={shareText}
        />
      )}

      {/* Skeleton mirrors the real panel's tile layout (same conditionals, no values yet) so
          when `me` lands the content fills in place instead of a new box appearing below. */}
      {!isDaily && !me && (
        <div className="panel results-earned" aria-hidden="true">
          <h3>Your game</h3>
          <div className="results-stat-row">
            {!isSolo && (
              <div className="stat-tile">
                <span className="stat-value"><span className="skeleton-bar" /></span>
                <span className="stat-label">Result</span>
              </div>
            )}
            <div className="stat-tile">
              <span className="stat-value"><span className="skeleton-bar" /></span>
              <span className="stat-label">Tiles</span>
            </div>
            <div className="stat-tile">
              <span className="stat-value"><span className="skeleton-bar" /></span>
              <span className="stat-label">Longest word</span>
            </div>
            {isTimed && durationMs != null && (
              <div className="stat-tile">
                <span className="stat-value"><span className="skeleton-bar" /></span>
                <span className="stat-label">Time</span>
              </div>
            )}
          </div>
        </div>
      )}

      {!isDaily && me && (
        <div className="panel results-earned">
          <h3>Your game</h3>
          <div className="results-stat-row">
            {!isSolo && (
              <div className="stat-tile">
                <span className="stat-value">{won ? 'Win' : 'Loss'}</span>
                <span className="stat-label">Result</span>
              </div>
            )}
            <div className="stat-tile">
              <span className="stat-value">{me.tile_count}</span>
              <span className="stat-label">Tiles</span>
            </div>
            <div className="stat-tile">
              <span className="stat-value">{longestWord ?? '-'}</span>
              <span className="stat-label">Longest word</span>
            </div>
            {isTimed && durationMs != null && (
              <div className="stat-tile">
                <span className="stat-value">
                  {Math.floor(durationMs / 60000)}:
                  {Math.floor((durationMs % 60000) / 1000).toString().padStart(2, '0')}
                </span>
                <span className="stat-label">Time</span>
              </div>
            )}
          </div>
          {earned.length === 0 && !achievementsSettled && (
            <div className="results-achievements" aria-hidden="true">
              <span className="results-achievements-label">
                Checking achievements… <span className="skeleton-bar" />
              </span>
            </div>
          )}
          {earned.length > 0 && (
            <div className="results-achievements">
              <span className="results-achievements-label">Achievements unlocked</span>
              <div className="results-achievement-icons">
                {earned.map((t) => (
                  <span key={t} className="results-achievement" title={ACHIEVEMENT_DEFS[t].description}>
                    {ACHIEVEMENT_DEFS[t].title}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
```

Phase 1 note: Phase 1 (spec 1.4) may have changed the non-daily skeleton or the achievements
placeholder in this region. If it has, keep Phase 1's version of those non-daily lines. The only
changes this step owns are:
- the `isDaily && <DailyYourGame …/>` insert
- the `!isDaily &&` guards on both panels
- dropping the now-dead `isDaily` conditionals inside them
- deleting the streak pill and the `daily-beat-percent` block

- [ ] **Step 10: Wire `Results.tsx`, remove the separate share card**

Replace:

```tsx
      {isDaily ? (
        <>
          <div className="daily-share-card">
            <span className="daily-share-title">Share your result</span>
            <pre className="daily-share-text">{shareText}</pre>
            <button type="button" onClick={handleShare}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
            {copyFailed && (
              <p className="error">Couldn't copy automatically. Select the text above instead.</p>
            )}
          </div>
          <p className="daily-note">Come back tomorrow for the next puzzle.</p>
```

with:

```tsx
      {isDaily ? (
        <>
          <p className="daily-note">Come back tomorrow for the next puzzle.</p>
```

- [ ] **Step 11: Typecheck (necessary, not proof)**

Run: `npm run typecheck --workspace @plantain/web`
Expected: exit 0. In particular, no unused-variable or `streak` nullability errors. This is NOT
evidence the page works; Step 12 is.

- [ ] **Step 12: Re-run the Step 1 browser test and confirm the markup passes**

Re-run the fixture (`--others=3`), reload the printed path, and run the Step 1 snippet again.
Expected:

```
hasDailyComponent: true
tileLabels: ["Longest word","Time","Day streak","Solvers beaten"]
shareBoxInPanel: true
streakPill: false
oldShareCard: false
pbLine: false
achievements: false
```

Also run:

```js
(() => {
  const tiles = [...document.querySelectorAll('.daily-stat-grid > .stat-tile')];
  return {
    values: tiles.map((t) => t.querySelector('.stat-value').textContent),
    badge: tiles[1]?.querySelector('.daily-pb-badge')?.textContent ?? null,
    shareText: document.querySelector('.daily-share-text')?.textContent,
    header: [document.querySelector('.daily-solved-callout')?.textContent, document.querySelector('.daily-solved-head .winner-line')?.textContent],
    boardWindow: document.querySelector('.results-board-window-title')?.textContent,
  };
})()
```

Expected:
- `values` is `["PLATES","2:03","<n>","67%"]`, where `<n>` ≥ 1 is the local streak.
- `badge` is `"Personal Best"`.
- `shareText` starts with `Plantain Pieces Daily Puzzle` and contains `⏱ 2:03` and `📝 Longest word: 6 letters`.
- `header[0]` is `"Solved!"`.
- `boardWindow` is `"Your board"`.

The layout is still unstyled at this point (tiles stack). That is expected until Task 4.

- [ ] **Step 13: Commit**

```bash
git add apps/web/src/components/DailyYourGame.tsx apps/web/src/pages/Results.tsx
git commit -m "$(cat <<'EOF'
feat(results): daily "Your game" panel with 4 tiles and nested share box

Daily Results now renders one DailyYourGame panel (Longest word, Time with a
Personal Best badge, Day streak, Solvers beaten) with the share box inside it.
Removes the streak pill, beat-percent/"Be the first" pills, the loose personal-best
line, the separate share card and the daily achievements block. Tiles show a
skeleton until their value settles; daily no longer waits on fetchPlayers.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Styles and tokens (2x2 grid, corner badge, sunken share box)

**Files:**
- Modify: `apps/web/src/styles/tokens.css:11` (after `--color-surface-inner`) and `:93` (after `--font-body`)
- Modify: `apps/web/src/styles.css:3800-3808` (`:root[data-contrast='high']` block)
- Modify: `apps/web/src/styles.css:4168-4198` (replace `.daily-share-card` / `.daily-share-title` / `.daily-share-text`)
- Modify: `apps/web/src/styles.css:4209-4234` (delete `.daily-streak-update` and `.daily-personal-best`)

**Interfaces:**
- Consumes: the class names produced by Task 3 (`.daily-your-game`, `.daily-stat-grid`, `.daily-stat-tile`, `.daily-pb-badge`, `.daily-share-box`, `.daily-share-head`, `.daily-share-title`, `.daily-share-copy`, `.daily-share-text`).
- Produces:
  - tokens `--color-surface-sunken` (one step darker than `--color-surface-inner`, the `.stat-tile` background) and `--font-mono`
  - a high-contrast override for `--color-surface-sunken`

- [ ] **Step 1: Write the failing browser layout test**

With the Task 3 page loaded (fixture `--others=3`, default PB), run with `javascript_tool`:

```js
(() => {
  if (!document.getElementById('no-motion')) {
    const s = document.createElement('style');
    s.id = 'no-motion';
    s.textContent = '*{transition:none!important;animation:none!important}';
    document.head.appendChild(s);
  }
  const panel = document.querySelector('.panel.results-earned');
  const tiles = [...panel.querySelectorAll('.daily-stat-grid > .stat-tile')];
  const r = tiles.map((t) => t.getBoundingClientRect());
  const eq = (a, b) => Math.abs(a - b) < 0.5;
  const box = panel.querySelector('.daily-share-box');
  const copy = panel.querySelector('.daily-share-copy').getBoundingClientRect();
  const boxR = box.getBoundingClientRect();
  const title = panel.querySelector('.daily-share-title').getBoundingClientRect();
  const badge = tiles[1].querySelector('.daily-pb-badge');
  const badgeR = badge?.getBoundingClientRect();
  const panelR = panel.getBoundingClientRect();
  const win = document.querySelector('.results-board-window');
  return {
    twoByTwo: eq(r[0].top, r[1].top) && eq(r[2].top, r[3].top) && r[2].top > r[0].top + 1 && eq(r[0].left, r[2].left) && eq(r[1].left, r[3].left),
    timeEqLongest: eq(r[0].width, r[1].width) && eq(r[0].height, r[1].height),
    allTilesEqual: r.every((x) => eq(x.width, r[0].width) && eq(x.height, r[0].height)),
    badgeText: badge?.textContent ?? null,
    badgeAtTopRight: !!badgeR && badgeR.right <= r[1].right + 0.5 && badgeR.right > r[1].left + r[1].width / 2 && badgeR.top < r[1].top + 4,
    badgeInsidePanel: !!badgeR && badgeR.left >= panelR.left && badgeR.right <= panelR.right && badgeR.top >= panelR.top,
    shareInsidePanel: panel.contains(box),
    shareBelowGrid: boxR.top >= Math.max(...r.map((x) => x.bottom)),
    copyRightAligned: boxR.right - copy.right < 24 && copy.left > title.right && Math.abs((copy.top + copy.height / 2) - (title.top + title.height / 2)) < 4,
    shareBg: getComputedStyle(box).backgroundColor,
    tileBg: getComputedStyle(tiles[0]).backgroundColor,
    panelBg: getComputedStyle(panel).backgroundColor,
    shareFont: getComputedStyle(panel.querySelector('.daily-share-text')).fontFamily,
    boardWindowBelowPanel: !!win && win.getBoundingClientRect().top >= panelR.bottom,
  };
})()
```

- [ ] **Step 2: Confirm the test fails before the CSS exists**

Expected (FAIL):
- `twoByTwo: false`. `.daily-stat-grid` is still a plain block, so the tiles stack in one column.
- `badgeAtTopRight: false`. The badge is still in normal flow.
- `shareBg` equals `panelBg` (transparent, or the inherited panel colour) instead of a colour darker than `tileBg`.
- `shareFont` does not contain `monospace`.

- [ ] **Step 3: Add the tokens**

In `apps/web/src/styles/tokens.css`, replace:

```css
  --color-surface-inner: #0f2f1e;
```

with:

```css
  --color-surface-inner: #0f2f1e;
  /* One step below --color-surface-inner: a well nested inside a panel that already holds
     surface-inner tiles (the daily Results share box). */
  --color-surface-sunken: #0a2116;
```

and replace:

```css
  --font-body: 'Nunito', sans-serif;
```

with:

```css
  --font-body: 'Nunito', sans-serif;
  --font-mono: ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace;
```

In `apps/web/src/styles.css`, inside `:root[data-contrast='high'] {`, replace:

```css
  --color-surface-inner: #08170f;
```

with:

```css
  --color-surface-inner: #08170f;
  --color-surface-sunken: #040d08;
```

- [ ] **Step 4: Replace the old share-card rules with the new panel rules**

In `apps/web/src/styles.css`, replace the three blocks `.daily-share-card { … }`, `.daily-share-title { … }` and `.daily-share-text { … }` (currently :4168-4198) with:

```css
/* Results — daily "Your game". 2x2 at every width; grid-auto-rows: 1fr keeps both rows the same
   height, so one tile's longer value (or the absolutely-positioned badge) can't make tiles differ. */
.daily-stat-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: 1fr;
  gap: var(--space-3);
}

.daily-stat-tile {
  position: relative;
  justify-content: center;
  min-width: 0;
}

/* Pinned to the Time tile's top-right corner and out of flow, so it never changes the tile's
   size. Overhangs the top edge only, and is inset from the right so it can't poke past the panel. */
.daily-pb-badge {
  position: absolute;
  top: calc(-1 * var(--space-2));
  right: var(--space-2);
  padding: 2px var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--color-secondary);
  color: var(--color-text-on-accent);
  font-family: var(--font-body);
  font-weight: 800;
  font-size: 0.68rem;
  line-height: 1.4;
  white-space: nowrap;
  pointer-events: none;
}

/* Nested share well: one step darker than the tiles above it. */
.daily-share-box {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4) var(--space-4);
  background: var(--color-surface-sunken);
  border-radius: var(--radius-md);
}

.daily-share-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.daily-share-title {
  margin: 0;
  font-family: var(--font-display);
  font-weight: 800;
  font-size: var(--text-small);
  color: var(--color-text-primary);
}

/* A compact version of the base button: same colours and hover (which only changes background,
   so the on-accent text stays legible), smaller footprint and press shadow. */
.daily-share-copy {
  flex-shrink: 0;
  padding: 6px var(--space-4);
  font-size: var(--text-small);
  box-shadow: var(--shadow-press-sm) var(--color-accent-shadow);
}

.daily-share-copy:active:not(:disabled) {
  box-shadow: 0 1px 0 var(--color-accent-shadow);
}

.daily-share-text {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--text-caption);
  line-height: 1.6;
  color: var(--color-text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
```

- [ ] **Step 5: Delete the dead pill and line rules**

In `apps/web/src/styles.css`, delete these two blocks entirely, comments included:

```css
/* Results page — streak confirmation after a daily solve. */
.daily-streak-update {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-pill);
  background: var(--color-surface-raised);
  border: 2px solid var(--color-secondary);
  font-family: var(--font-display);
  font-weight: 800;
  font-size: var(--text-body);
  color: var(--color-secondary);
}

/* Results page — daily-puzzle personal-best badge, under the beat-percent pill. */
.daily-personal-best {
  display: block;
  margin-top: var(--space-1);
  font-family: var(--font-body);
  font-weight: 700;
  font-size: var(--text-small);
  color: var(--color-accent);
  text-align: center;
}
```

Then confirm no other references remain:
Run: `git grep -n "daily-streak-update\|daily-personal-best\|daily-share-card\|daily-beat-percent" -- apps/web/src`
Expected: no output (exit code 1).

- [ ] **Step 6: Re-run the Step 1 browser test and confirm it passes**

Reload the results page (Vite HMR may not re-run the injected style; the snippet re-injects it) and run the Step 1 snippet. Expected:

```
twoByTwo: true
timeEqLongest: true
allTilesEqual: true
badgeText: "Personal Best"
badgeAtTopRight: true
badgeInsidePanel: true
shareInsidePanel: true
shareBelowGrid: true
copyRightAligned: true
shareBg: "rgb(10, 33, 22)"
tileBg: "rgb(15, 47, 30)"
shareFont: contains "monospace"
boardWindowBelowPanel: true
```

`shareBg` is `#0a2116` and `tileBg` is `#0f2f1e`, so the share box is darker.

Then prove the badge does not change the tile's size:

```js
(() => {
  const time = document.querySelectorAll('.daily-stat-grid > .stat-tile')[1];
  const before = time.getBoundingClientRect();
  const badge = time.querySelector('.daily-pb-badge');
  const parent = badge.parentNode;
  const next = badge.nextSibling;
  badge.remove();
  const after = time.getBoundingClientRect();
  parent.insertBefore(badge, next);
  return { sameWidth: Math.abs(before.width - after.width) < 0.5, sameHeight: Math.abs(before.height - after.height) < 0.5 };
})()
```

Expected: `{ sameWidth: true, sameHeight: true }`.

Take a `computer` → `screenshot` of the panel and check visually that:
- the 4 tiles sit in a 2x2 grid
- the yellow "Personal Best" badge overhangs the Time tile's top-right corner
- the darker share box sits inside the panel, with "Share your result" on the left, Copy on the right, and monospace text below

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/styles/tokens.css apps/web/src/styles.css
git commit -m "$(cat <<'EOF'
style(results): daily Your game 2x2 grid, Personal Best badge, sunken share box

New --color-surface-sunken (with high-contrast override) and --font-mono tokens.
Badge is absolutely positioned so it can't change the Time tile's size; rows are
forced equal. Removes the now-unused streak pill, personal-best line and share
card rules.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: State coverage (First!, no personal best, skeletons, narrow width, copy)

The markup and styles exist. This task proves the remaining spec behaviours in the real page. If a
check fails, fix it in `DailyYourGame.tsx` / `styles.css` and re-run the check before committing.

**Files:**
- Modify (only if a check below fails): `apps/web/src/components/DailyYourGame.tsx`, `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 2's fixture flags `--others=0` and `--no-pb`, and the Task 3/4 DOM.
- Produces: nothing new. This task is verification only.

- [ ] **Step 1: "First!" and no-badge states, test**

In Bash: `node scripts/fixture-daily-results.mjs --profile=<tab profileId> --date=<tab date> --others=0 --no-pb`
Expected output includes `"expect":{"time":"2:03","solversBeaten":"First!","personalBest":false}`.
Navigate to the printed path and run:

```js
(() => {
  const tiles = [...document.querySelectorAll('.daily-stat-grid > .stat-tile')];
  const r = tiles.map((t) => t.getBoundingClientRect());
  return {
    solvers: tiles[3].querySelector('.stat-value').textContent,
    badge: !!tiles[1].querySelector('.daily-pb-badge'),
    bePill: [...document.querySelectorAll('*')].some((e) => e.children.length === 0 && /Be the first/.test(e.textContent)),
    pbLine: [...document.querySelectorAll('*')].some((e) => e.children.length === 0 && /New personal best/.test(e.textContent)),
    timeEqLongest: Math.abs(r[0].height - r[1].height) < 0.5 && Math.abs(r[0].width - r[1].width) < 0.5,
  };
})()
```

- [ ] **Step 2: Confirm the results**

Expected: `{ solvers: "First!", badge: false, bePill: false, pbLine: false, timeEqLongest: true }`.
If `solvers` is `"-"`, the summary never arrived. Check `read_network_requests` with `urlPattern: "result-summary"`: a non-200 means the `api` preview isn't running or `apps/web/.env.local`'s `VITE_API_URL` is wrong.

- [ ] **Step 3: Skeleton while loading, test**

Still on a daily results page, delay the summary request in the page, then remount Results through the SPA router (so the patched `fetch` survives):

```js
(async () => {
  if (!window.__origFetch) window.__origFetch = window.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    return /result-summary/.test(url)
      ? new Promise((res) => setTimeout(() => res(window.__origFetch(input, init)), 6000))
      : window.__origFetch(input, init);
  };
  const back = location.pathname;
  history.pushState({}, '', '/');
  dispatchEvent(new PopStateEvent('popstate'));
  await new Promise((r) => setTimeout(r, 300));
  history.pushState({}, '', back);
  dispatchEvent(new PopStateEvent('popstate'));
  await new Promise((r) => setTimeout(r, 1500));
  const tiles = [...document.querySelectorAll('.daily-stat-grid > .stat-tile')];
  const r = tiles.map((t) => t.getBoundingClientRect());
  return {
    solversSkeleton: !!tiles[3]?.querySelector('.stat-value .skeleton-bar'),
    solversBusy: tiles[3]?.getAttribute('aria-busy'),
    noBadgeYet: !tiles[1]?.querySelector('.daily-pb-badge'),
    sizesStable: r.length === 4 && r.every((x) => Math.abs(x.height - r[0].height) < 0.5),
    heightWhileLoading: r[3]?.height,
  };
})()
```

Then, after waiting ~7s (one `computer` → `wait` of 7), run:

```js
(() => {
  const tiles = [...document.querySelectorAll('.daily-stat-grid > .stat-tile')];
  window.fetch = window.__origFetch;
  return { solvers: tiles[3].querySelector('.stat-value').textContent, height: tiles[3].getBoundingClientRect().height };
})()
```

- [ ] **Step 4: Confirm the results**

Expected, first snippet: `solversSkeleton: true`, `solversBusy: "true"`, `noBadgeYet: true`, `sizesStable: true`.
Expected, second snippet: `solvers` is `"First!"` (or a percentage if other rows now exist), and `height` equals the first snippet's `heightWhileLoading` within 0.5px. That means no layout shift when the value lands.

Both summary attempts (t=0 and t=1000ms) are delayed 6s, so the final attempt is still in flight at
1.5s and `summarySettled` is false. That is why the skeleton, not `"-"`, is expected.

- [ ] **Step 5: Narrow width (2x2 holds, no overflow), test**

Per CLAUDE.md, `resize_window` is unreliable for this. Pin the panel to phone widths and measure:

```js
(() => {
  const panel = document.querySelector('.panel.results-earned');
  const out = {};
  for (const w of [320, 280]) {
    panel.style.width = `${w}px`;
    const tiles = [...panel.querySelectorAll('.daily-stat-grid > .stat-tile')];
    const r = tiles.map((t) => t.getBoundingClientRect());
    const pr = panel.getBoundingClientRect();
    const badge = panel.querySelector('.daily-pb-badge')?.getBoundingClientRect();
    out[w] = {
      twoByTwo: Math.abs(r[0].top - r[1].top) < 0.5 && Math.abs(r[2].top - r[3].top) < 0.5 && r[2].top > r[0].top,
      panelNoOverflow: panel.scrollWidth <= panel.clientWidth,
      tilesInside: r.every((x) => x.left >= pr.left - 0.5 && x.right <= pr.right + 0.5),
      badgeInside: !badge || (badge.left >= pr.left && badge.right <= pr.right),
      shareNoOverflow: (() => { const b = panel.querySelector('.daily-share-box'); return b.scrollWidth <= b.clientWidth; })(),
    };
  }
  panel.style.width = '';
  return out;
})()
```

Run it once on the `--no-pb` page and once after re-running the fixture without `--no-pb`, so the badge is present.

- [ ] **Step 6: Confirm the results**

Expected, for both 320 and 280, in both runs: every field is `true`. If `twoByTwo` breaks at 280
because a long word forces a min-content width, `minmax(0, 1fr)` plus `.stat-value`'s existing
`word-break: break-word` should already prevent it. If not, add `min-width: 0` to `.daily-stat-tile .stat-value`
and re-run.

- [ ] **Step 7: Copy button, test**

```js
(async () => {
  const btn = document.querySelector('.daily-share-copy');
  let written = null;
  const orig = navigator.clipboard?.writeText?.bind(navigator.clipboard);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { written = t; } } });
  btn.click();
  await new Promise((r) => setTimeout(r, 50));
  const label = btn.textContent;
  const expected = document.querySelector('.daily-share-text').textContent;
  if (orig) Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: orig } });
  return { label, matches: written === expected, written };
})()
```

- [ ] **Step 8: Confirm the results**

Expected: `{ label: "Copied!", matches: true }`, and `written` is the exact share text (unchanged
lines: title, date, time, streak, longest-word length, URL). Take a final `screenshot` of the full
page as the visual record.

- [ ] **Step 9: Commit (only if Steps 1-8 required fixes)**

```bash
git add apps/web/src/components/DailyYourGame.tsx apps/web/src/styles.css
git commit -m "$(cat <<'EOF'
fix(results): daily Your game state/width fixes found in browser verification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

If nothing needed fixing, skip the commit and record "Task 5: all checks passed, no changes" in the hand-off.

---

### Task 6: Regression check on solo/multiplayer Results and CLAUDE.md status entry

**Files:**
- Modify: `CLAUDE.md`, under "## Current status", inserting one bullet directly before the `- ➡️ **Next up:` bullet

**Interfaces:**
- Consumes: the Task 3 `!isDaily` guards.
- Produces: a dated status bullet.

- [ ] **Step 1: Non-daily Results unchanged, test**

In the preview, from Home, open "Play Solo!", pick Quick, and play to a finish. Alternatively reuse a
finished solo room id if one exists locally. Once on `/room/<id>/results`, run:

```js
(() => ({
  dailyPanel: !!document.querySelector('.daily-your-game'),
  labels: [...document.querySelectorAll('.results-stat-row .stat-label')].map((e) => e.textContent),
  achievementsArea: !!document.querySelector('.results-achievements') || document.querySelectorAll('.results-earned').length === 1,
  playAgain: [...document.querySelectorAll('button')].some((b) => /Play Again|Rematch/.test(b.textContent)),
}))()
```

- [ ] **Step 2: Confirm the results**

Expected:
- `dailyPanel: false`
- `labels` is `["Tiles","Longest word"]`, plus `"Time"` for Timed solo, or `["Result","Tiles","Longest word"]` for multiplayer
- `achievementsArea: true`
- `playAgain: true`

This is the same output the pre-change page produced.

- [ ] **Step 3: Add the status bullet**

In `CLAUDE.md`, insert before the line starting `- ➡️ **Next up:`:

```markdown
- ✅ **Daily Results "Your game" redesign (2026-10-06, Phase 2 of the polish spec).** Daily now
  renders `DailyYourGame.tsx`: one `.panel.results-earned` with a 2x2 `.stat-tile` grid (Longest
  word · Time with an absolutely-positioned "Personal Best" corner badge · Day streak · Solvers
  beaten = `X%` or `First!`) and a nested `--color-surface-sunken` share box (monospace text, Copy
  right-aligned). The streak pill, beat-percent/"Be the first" pills, loose personal-best line,
  separate share card and the daily achievements block are gone. Tile logic is pure and tested in
  `packages/shared/src/dailyResults.ts`; each tile shows a skeleton until its value *settles*
  (`longestWordReady` / `dailySummarySettled` in `Results.tsx`), so an early `available: false`
  from the summary (archive not written yet) doesn't flash "-". The daily panel no longer waits on
  `fetchPlayers`. Browser-verified with `scripts/fixture-daily-results.mjs` (LOCAL-only; builds a
  finished daily room for the tab's own guest): equal tile rects with/without the badge, 2x2 at
  280/320px, skeleton→value with no height change, copy writes the unchanged share text.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(claude-md): record Phase 2 daily Results redesign

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review against spec Phase 2

| Spec bullet | Covered by |
|---|---|
| Matches the solo/multiplayer pattern: one `.panel.results-earned` with a tile grid and the share box nested inside | Task 3 Step 3 (component root `.panel.results-earned`, share `section` inside). Task 4 Step 6 `shareInsidePanel`. |
| Removed: `.daily-streak-update` pill under the header | Task 3 Step 9 (JSX deleted), Task 4 Step 5 (CSS deleted + `git grep` empty), Task 3 Step 12 `streakPill: false` |
| Removed: "Be the first to solve today!" pill | Task 3 Step 9 (`daily-beat-percent` block deleted), Task 5 Step 2 `bePill: false` |
| Removed: loose "New personal best!" line | Task 3 Step 9, Task 4 Step 5, Task 5 Step 2 `pbLine: false` |
| Removed: separate `.daily-share-card` below the board | Task 3 Step 10, Task 4 Step 4 (rules replaced), Task 3 Step 12 `oldShareCard: false` |
| Personal Best: small `--color-secondary` badge, Time tile top-right, text exactly "Personal Best", no size change | Task 3 Step 3 (literal `'Personal Best'`, no `text-transform` in CSS so `textContent` and render match). Task 4 Step 4 (`position: absolute`, `--color-secondary`). Task 4 Step 6: `badgeText`, `badgeAtTopRight`, and the remove-badge size comparison `sameWidth/sameHeight`. Task 5 Step 2 `timeEqLongest` with no badge. |
| Solvers beaten: `X%` from `getDailyResultSummary`, `First!` for the first solver, skeleton while loading | Task 1 (`solversBeatenLabel` + tests incl. `beatPercent: null` → First!). Task 3 Step 12 (`67%`). Task 5 Steps 1-2 (`First!`), Steps 3-4 (skeleton, then value, same height). |
| Share box: nested, darker than tile surface (new token), heading "Share your result", Copy right-aligned, monospace text | Task 4 Step 3 (`--color-surface-sunken` darker than `--color-surface-inner`, plus high-contrast override; `--font-mono`). Task 4 Step 4. Task 4 Step 6 (`shareBg` < `tileBg`, `copyRightAligned`, `shareFont` monospace). |
| Share text content unchanged | Task 3 Step 8 changes only a null guard with identical output. Task 5 Step 8 compares the copied text to the rendered text, and Task 3 Step 12 checks its lines. |
| No achievements section on daily | Task 3 Step 9 (achievements only inside the `!isDaily && me` panel). Task 3 Step 12 `achievements: false`. This is compatible with Phase 1 skipping the daily achievement fetch. |
| "Your board" window stays below, unchanged | Not edited. Task 3 Step 12 `boardWindow: "Your board"`. Task 4 Step 6 `boardWindowBelowPanel`. |
| Header ("Solved!" + date) unchanged | Not edited. Task 3 Step 12 `header`. |
| 4 tiles in a 2×2 grid at every width, tiles reuse `.stat-tile` | Task 4 Step 4 (`repeat(2, minmax(0,1fr))`, no breakpoint). Tiles carry `stat-tile`. Task 4 Step 6 `twoByTwo`, Task 5 Steps 5-6 at 320/280px. |
| Testing section: Phase 2 browser-verified with screenshots, `*{transition:none}` injected | Task 4 Steps 1/6 inject the style. Screenshots in Task 4 Step 6 and Task 5 Step 8. No typecheck is cited as proof (Task 3 Step 11 is labelled "necessary, not proof"). |
| Phase 1 dependency (parallel fetches, no daily achievement fetch, fixed-size placeholders) | Global Constraint plus the Phase 1 notes in Task 3 Steps 6, 7 and 9. Edits are anchored on quoted code, keep Phase 1's non-daily lines, and add only the `isFinal` settle flags. The daily panel's per-tile skeletons satisfy 1.4's "fixed-size placeholder" for this section. |

Gaps found and fixed inline while reviewing:
1. Rendering `"-"` for Solvers beaten on the first `available: false` reply would have flashed before the 1000ms retry. Fixed with the `settled` parameter (Task 1) and `dailySummarySettled` (Task 3 Step 7).
2. `streak` started at `0` and would have flashed "0" in the Day streak tile. It is now `number | null` (Task 3 Step 5), and the share text's guard was made null-safe without changing its output (Step 8).
3. The daily panel was gated on `me` (`fetchPlayers`) even though none of its values need it. It now renders immediately (Task 3 Step 9) with per-tile skeletons.
4. A missing `puzzleId` would have left the Solvers tile skeleton forever. It now settles immediately (Task 3 Step 7).
5. `text-transform: uppercase` on the badge would make the rendered text differ from "Personal Best". It was deliberately left out (Task 4 Step 4).
