# Phase 1 Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 1 (sections 1.1–1.6) of
`docs/superpowers/specs/2026-10-06-polish-solo-batches-easter-eggs-design.md`: a stable-height
empty tray, no Bunch card on daily, per-mode stat-tile visibility, a Stats tab that loads once
and switches modes with no delay or resize, and a daily Results page that loads everything in
parallel, skips the achievement polling, and doesn't shift as data arrives.

**Architecture:** Client-only changes in `apps/web`. No migration, RPC or Worker change. Pure
logic gets pulled into small modules with vitest coverage: `lib/statTiles.ts` (the per-tile
`modes` predicate), `lib/statsView.ts` (per-mode view derived from all of the caller's
`profile_stats` rows), and `lib/resultsPlan.ts` (which Results fetches run for which mode).
`apps/web` gets a minimal vitest setup (it has none today), with tests in `apps/web/test/`,
outside `tsconfig`'s `src` include, the same way `packages/shared/test/` sits outside its
`src`. Layout fixes (tray, topbar, placeholders) are checked in the Claude Browser pane with
concrete measurement snippets.

**Tech Stack:** React 18 + TypeScript + Vite 5, vitest 2.1.x (already hoisted at the repo root
via `packages/shared`), plain CSS (`apps/web/src/styles.css`), Supabase local stack for the
browser checks that need data.

## Global Constraints

- Package manager: **npm workspaces, NOT pnpm**. Use `npm`.
- Branch: `polish-solo-batches-easter-eggs`. Scope: **Phase 1 only (1.1–1.6)**. Don't do any of Phase 2's daily Results redesign early: the streak pill, beat-percent pill and share card stay where they are in this phase.
- Verification honesty: a passing typecheck/build/unit test **never** proves a UI or runtime fix. If a browser check can't run (Docker down, no data), say so in the report. Don't claim it.
- Claude Browser pane: inject `*{transition:none!important}` before reading any computed style. The pane freezes transitioning properties at their start value.
- `resize_window` is unreliable for overflow testing. Use a fixed-width wrapper harness, and confirm that the intended media query actually matched with `matchMedia` inside the same snippet.
- Any button with a visibly "on" state gets the shared `.toggle-btn` class. Never hand-write `.X.active`/`.X.selected` colours.
- A component `:hover` rule that changes `background` must also restate `color`.
- No client writes to game tables. Phase 1 adds no RPCs and no migrations.
- `tsconfig.base.json` has `noUnusedLocals`/`noUnusedParameters`. Remove any import an edit leaves unused.
- Typecheck: `npm run typecheck --workspace @plantain/web`. Web unit tests (after Task 3): `npm test --workspace @plantain/web`.
- Local DB shell (Git Bash): `MSYS_NO_PATHCONV=1 docker exec supabase_db_plantain-pieces psql -U postgres -d postgres -c "<sql>"`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Empty tray keeps one chip row of height (spec 1.5)

**Files:**
- Modify: `apps/web/src/styles.css:1463-1491` (`.tile-rack`, plus a new `.tile-rack.empty` rule right after it)
- Modify: `apps/web/src/styles.css:3015-3017` (`@media (min-width: 1024px)` `.tile-rack`)
- Modify: `apps/web/src/styles.css:3236-3238` (`@media (max-height: 550px) and (orientation: landscape)` `.tile-rack`)
- Modify: `apps/web/src/components/Tray.tsx:72`
- Test: browser measurement snippet (below). No unit test fits a pure layout fix.

**Interfaces:**
- Consumes: nothing new.
- Produces: CSS custom property `--rack-row-h` on `.tile-rack` (66px default, 78px at ≥1024px), and the class `tile-rack empty` when `items.length === 0`.

- [ ] **Step 1: Start the web preview and reproduce the bug.** Call `preview_start` with `name: "web"`. Supabase doesn't need to be up, because `styles.css` loads globally even when Home can't open a session. Call `resize_window` with `width: 800, height: 900`. Then run this with `javascript_tool`. It builds four real `.rack-dock` trees in a fixed-width 420px wrapper and measures them:

```js
(() => {
  if (!document.getElementById('probe-no-transition')) {
    const s = document.createElement('style');
    s.id = 'probe-no-transition';
    s.textContent = '*{transition:none!important;animation:none!important}';
    document.head.appendChild(s);
  }
  document.getElementById('rack-probe')?.remove();
  const host = document.createElement('div');
  host.id = 'rack-probe';
  host.style.cssText = 'position:fixed;left:0;top:0;width:420px;z-index:99999;display:flex;flex-direction:column;gap:4px;background:#000';
  const chips = (n, pendingFirst) => Array.from({ length: n }, (_, i) =>
    `<button type="button" class="tile-chip${pendingFirst && i === 0 ? ' pending' : ''}">A</button>`).join('');
  const states = {
    empty: '<p class="hint">All tiles placed. Nice.</p>',
    onePending: chips(1, true),
    one: chips(1, false),
    row: chips(5, false),
  };
  host.innerHTML = Object.entries(states).map(([k, inner]) =>
    `<div class="rack-dock" data-state="${k}"><div class="tray-toolbar"><button type="button" class="tray-tool toggle-btn"><span>R</span><span class="tray-tool-label">Recall invalid</span></button></div><div class="tile-rack${k === 'empty' ? ' empty' : ''}" data-tray>${inner}</div></div>`).join('');
  document.body.appendChild(host);
  const out = {
    viewport: `${innerWidth}x${innerHeight}`,
    large: matchMedia('(min-width: 1024px)').matches,
    mobile: matchMedia('(max-width: 600px)').matches,
    landscape: matchMedia('(max-height: 550px) and (orientation: landscape)').matches,
  };
  for (const dock of host.querySelectorAll('.rack-dock')) {
    const rack = dock.querySelector('.tile-rack');
    const tops = [...rack.querySelectorAll('.tile-chip')].map((c) => c.offsetTop);
    out[dock.dataset.state] = {
      dock: dock.getBoundingClientRect().height,
      rack: rack.getBoundingClientRect().height,
      singleRow: new Set(tops).size <= 1,
    };
  }
  host.remove();
  return out;
})()
```

Expected **before the fix**: `empty.rack` is smaller than `one.rack`, and `one.rack === 66`. `onePending.rack === one.rack`, because the invisible pending chip still takes its slot. That's the reported jump. Write down the numbers.

- [ ] **Step 2: Add the one-row floor to `.tile-rack`.** In `apps/web/src/styles.css`, inside the `.tile-rack { ... }` rule (:1463), insert these lines directly after `padding: 8px 10px 12px;` and its comment:

```css
  /* One chip row + this rule's own 8px/12px vertical padding (border-box), so an empty tray is
     exactly as tall as a one-row tray and a freshly drawn tile -- even a .pending, invisible
     one -- can't grow the dock. Restated wherever .tile-chip's height changes (the
     min-width:1024px block); the landscape block caps it with min() against its own max-height. */
  --rack-row-h: 66px;
  min-height: var(--rack-row-h);
```

Then add this new block right after the closing `}` of `.tile-rack` (before `.tile-rack::-webkit-scrollbar`):

```css
/* Empty tray: center the "All tiles placed" hint inside the reserved one-row height. Uses
   align-content, not margin:auto -- a wrapping flex line is only as tall as its content, so auto
   margins would have nothing to distribute. */
.tile-rack.empty {
  align-content: center;
}

.tile-rack.empty .hint {
  margin: 0;
}
```

- [ ] **Step 3: Restate the floor at the large breakpoint and cap it in landscape.** In the `@media (min-width: 1024px)` block, replace

```css
  .tile-rack {
    gap: 14px;
  }
```

with

```css
  .tile-rack {
    gap: 14px;
    --rack-row-h: 78px; /* 58px chip (below) + 20px vertical rack padding */
  }
```

In the `@media (max-height: 550px) and (orientation: landscape)` block, replace

```css
  .tile-rack {
    max-height: 18vh;
  }
```

with

```css
  .tile-rack {
    max-height: 18vh;
    /* min-height beats max-height when they conflict, so cap the one-row floor at the same 18vh
       or an empty tray would end up taller than this block lets a full one be. */
    min-height: min(var(--rack-row-h), 18vh);
  }
```

- [ ] **Step 4: Tag the empty rack in `Tray.tsx`.** In `apps/web/src/components/Tray.tsx:72` replace

```tsx
      <div className="tile-rack" data-tray>
```

with

```tsx
      <div className={`tile-rack${items.length === 0 ? ' empty' : ''}`} data-tray>
```

- [ ] **Step 5: Re-measure at every breakpoint.** Run the Step 1 snippet again after each of these `resize_window` calls, and confirm the `large`/`mobile`/`landscape` flags match the row before trusting the numbers:

| resize_window | flags expected | expected `rack` for empty / onePending / one / row |
|---|---|---|
| 800×900 | none | 66 / 66 / 66 / 66 |
| 375×812 | mobile | 66 / 66 / 66 / 66 |
| 1280×900 | large | 78 / 78 / 78 / 78 |
| 800×360 | landscape | 64.8 / 64.8 / 64.8 / 64.8 (18vh) |
| 1100×500 | large + landscape | 78 / 78 / 78 / 78 |

Pass criteria: in every row, `dock` is identical across all four states, `row.singleRow === true`, and `rack` matches the table. If `resize_window` doesn't produce the flags you expect, record that viewport as unverified. Don't count it as a pass. Finish with `resize_window` `preset: "desktop"`.

- [ ] **Step 6: Typecheck.** Run `npm run typecheck --workspace @plantain/web`. Expected: exit 0 with no output.

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/styles.css apps/web/src/components/Tray.tsx
git commit -m "$(cat <<'EOF'
fix(tray): reserve one chip row so the empty tray doesn't grow on draw

.tile-rack had no min-height, so the 20px "All tiles placed" hint was the
whole tray until a drawn (even .pending, invisible) chip mounted and grew it
by a row. Floor is a --rack-row-h custom property restated at the large
breakpoint and capped by min() against the landscape max-height.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: No Bunch card on daily (spec 1.6)

**Files:**
- Modify: `apps/web/src/pages/Game.tsx:602` (add `showBunchCard` after `isDaily`)
- Modify: `apps/web/src/pages/Game.tsx:1694-1704` (topbar)
- Modify: `apps/web/src/styles.css` `@media (max-width: 600px)` block, right after the `.topbar-roster-card, .topbar-elapsed-card { order: 3; flex: 1 1 100%; }` rule (~:3077-3081)
- Test: browser check against a live daily game (below).

**Interfaces:**
- Consumes: `isDaily` (`Game.tsx:602`), `room`.
- Produces: `const showBunchCard: boolean`, and the class `game-topbar no-bunch` when the card is omitted.

- [ ] **Step 1: Bring up the stack and seed a local daily puzzle.** Run `npm run db:start`. If Docker won't come up, stop and report Task 2's browser check as unverified. Then seed a puzzle for yesterday, today and tomorrow, so the client's local date matches whatever the DB's UTC `current_date` is:

```bash
MSYS_NO_PATHCONV=1 docker exec supabase_db_plantain-pieces psql -U postgres -d postgres -c "
insert into public.daily_puzzles
  (language, letter_multiset, grid_state, dictionary_config, floor_score, spread_score,
   distinct_board_count, replay_run_count, status, scheduled_date, generation_seed, first_word)
select 'en', 'PLANTAINSAREGREATFUNX', '{}'::jsonb,
       '{\"minLength\":2,\"maxLength\":null,\"baseEnabled\":true,\"excludedTopics\":[],\"customSetIds\":[]}'::jsonb,
       1.0, 0.5, 1, 1, 'scheduled', d::date, 1, 'PROBE'
from generate_series(current_date - 1, current_date + 1, interval '1 day') as d
where not exists (select 1 from public.daily_puzzles p where p.language = 'en' and p.scheduled_date = d::date);"
```

Expected: `INSERT 0 N` with N between 0 and 3.

- [ ] **Step 2: Capture the failing state.** Call `preview_start` with `name: "api"`, then with `name: "web"`. Navigate to `/daily`, use `find` to locate the start button, and click it. Once the URL is `/room/<id>/game`, run:

```js
(() => {
  const bar = document.querySelector('.game-topbar');
  return {
    bunchCard: !!bar.querySelector('.topbar-bunch-card'),
    noBunch: bar.classList.contains('no-bunch'),
    barW: Math.round(bar.getBoundingClientRect().width),
    cards: [...bar.children].map((c) => {
      const r = c.getBoundingClientRect();
      return { cls: c.className, top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width) };
    }),
  };
})()
```

Expected **before the fix**: `bunchCard: true` on a daily game. Keep the room id; Task 5 reuses it.

- [ ] **Step 3: Add `showBunchCard`.** In `apps/web/src/pages/Game.tsx`, directly after `const isDaily = room?.mode === 'daily';` (:602), insert:

```tsx
  // Daily deals its whole puzzle up front (the Bunch starts at 0 and never moves), so the meter
  // could only ever show an empty plantain: drop the card and let the other cards take the row.
  // Waits for the room so a daily game never flashes the card while it loads.
  const showBunchCard = room != null && !isDaily;
```

- [ ] **Step 4: Render the card conditionally.** Replace `Game.tsx:1694-1704`:

```tsx
      <div className="game-topbar">
        <div className="topbar-card topbar-bunch-card">
          {room && (
            <BunchGraphic
              ref={plantainCutRef}
              bunchCount={bunchCount}
              startingBunchCount={startingBunchCount}
              flashSignal={flashSignal}
            />
          )}
        </div>
```

with

```tsx
      <div className={`game-topbar${showBunchCard ? '' : ' no-bunch'}`}>
        {showBunchCard && (
          <div className="topbar-card topbar-bunch-card">
            <BunchGraphic
              ref={plantainCutRef}
              bunchCount={bunchCount}
              startingBunchCount={startingBunchCount}
              flashSignal={flashSignal}
            />
          </div>
        )}
```

(`plantainCutRef` is then null on daily. `SliceFlyLayer`'s `from` already returns `null` for that case and reveals immediately, and daily never draws anyway.)

- [ ] **Step 5: Mobile topbar: promote the elapsed card into row 1.** In `apps/web/src/styles.css`, inside `@media (max-width: 600px)`, add this right after the `.topbar-roster-card, .topbar-elapsed-card { order: 3; flex: 1 1 100%; }` rule:

```css
  /* Daily has no Bunch card (spec 1.6): without this, row 1 would hold the actions card alone
     and the elapsed card would sit on a row of its own beneath it. (0,3,0) beats the (0,1,0)
     order/flex rule above regardless of position. */
  .game-topbar.no-bunch .topbar-elapsed-card {
    order: 1;
    flex: 1 1 0;
    min-width: 0;
  }
```

- [ ] **Step 6: Re-run the Step 2 snippet.** Reload the daily game.
  - Desktop (`resize_window` `preset: "desktop"`): expect `bunchCard: false` and `noBunch: true`. The `.topbar-elapsed-card` should start at the bar's left padding (`left` ≈ bar left + 16), and `elapsed.w + actions.w + 12` (gap) should equal `barW - 32` (padding) within 1px, so there's no hole where the bunch card used to be.
  - Mobile (`resize_window` 375×812, then reload): expect `.topbar-elapsed-card` and `.topbar-actions-card` to have the **same `top`**.
  - Regression: start a solo game from `/solo` (Quick) and run the snippet. Expect `bunchCard: true` and `noBunch: false`.
  - Finish with `resize_window` `preset: "desktop"`.

- [ ] **Step 7: Typecheck.** `npm run typecheck --workspace @plantain/web`. Expected: exit 0.

- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/pages/Game.tsx apps/web/src/styles.css
git commit -m "$(cat <<'EOF'
fix(daily): drop the Bunch card from the daily topbar

Daily deals the whole puzzle at once, so the meter could only ever read
empty. The elapsed card takes the space; on mobile it moves up beside the
actions card instead of leaving row 1 half empty.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Per-mode stat-tile visibility + web vitest setup (spec 1.1)

**Files:**
- Modify: `apps/web/package.json` (add `test` script + `vitest` devDependency), `package-lock.json`
- Create: `apps/web/src/lib/statTiles.ts`
- Create: `apps/web/test/fixtures.ts`
- Create: `apps/web/test/statTiles.test.ts`
- Modify: `apps/web/src/pages/Profile.tsx:1-23` (imports), `:61` (local `StatsFilter` type), `:463-471` (`StatsBoardProps`), `:473-480` (`formatBestTime`, moved), `:512-572` (tile construction)

**Interfaces:**
- Consumes: `ProfileStatsRow`, `GameMode` (`apps/web/src/lib/profile.ts`, type-only), `BUNCH_SIZE_PRESETS` (`@plantain/shared`).
- Produces (in `apps/web/src/lib/statTiles.ts`):
  - `export type StatsFilter = 'all' | GameMode;`
  - `export interface StreakInfo { current: number; longest: number; }`
  - `export interface StatTileDef { label: string; modes: readonly StatsFilter[]; value: (stats: ProfileStatsRow, streak: StreakInfo | null) => string | number; }`
  - `export interface StatTile { label: string; value: string | number; }`
  - `export const STAT_TILE_DEFS: readonly StatTileDef[]`
  - `export function formatBestTime(ms: number | undefined): string`
  - `export function visibleStatTiles(filter: StatsFilter): StatTileDef[]`
  - `export function buildStatTiles(stats: ProfileStatsRow, streak: StreakInfo | null, filter: StatsFilter): StatTile[]`
- Produces (in `apps/web/test/fixtures.ts`): `export function statsRow(overrides?: Partial<ProfileStatsRow>): ProfileStatsRow`

- [ ] **Step 1: Add vitest to `apps/web`.** In `apps/web/package.json`, add `"test": "vitest run"` to `scripts` after `"typecheck"`, and `"vitest": "^2.1.8"` to `devDependencies` after `"vite"` (the same range `packages/shared` uses). The result:

```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
```

```json
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "typescript": "^5.6.3",
    "vite": "^5.4.10",
    "vitest": "^2.1.8"
  }
```

Run `npm install` from the repo root. Expected: it completes and only touches `package-lock.json`. vitest 2.1.9 is already hoisted, so nothing should download. No vitest config file is needed, because vitest picks up `apps/web/vite.config.ts`.

- [ ] **Step 2: Write the shared test fixture.** Create `apps/web/test/fixtures.ts`:

```ts
import type { ProfileStatsRow } from '../src/lib/profile.js';

/** A zeroed profile_stats row (every column at its DB default), overridable per test. */
export function statsRow(overrides: Partial<ProfileStatsRow> = {}): ProfileStatsRow {
  return {
    profile_id: '00000000-0000-0000-0000-000000000001',
    mode: 'multiplayer',
    games_played: 0,
    games_won: 0,
    total_peels: 0,
    total_dumps: 0,
    total_words: 0,
    total_word_length: 0,
    longest_word: null,
    longest_word_length: 0,
    fastest_peel_ms: null,
    rarest_word: null,
    rarest_word_score: 0,
    best_peel_streak: 0,
    first_letter_counts: {},
    solo_best_times: {},
    daily_best_time_ms: null,
    daily_total_time_ms: 0,
    ...overrides,
  };
}
```

- [ ] **Step 3: Write the failing test.** Create `apps/web/test/statTiles.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildStatTiles, formatBestTime, visibleStatTiles, type StatsFilter } from '../src/lib/statTiles.js';
import { statsRow } from './fixtures.js';

const labels = (filter: StatsFilter) => visibleStatTiles(filter).map((t) => t.label);

describe('visibleStatTiles', () => {
  it('daily shows exactly the nine tiles that can carry information', () => {
    expect(labels('daily')).toEqual([
      'Games played',
      'Current streak',
      'Longest streak',
      'Longest word',
      'Rarest word',
      'Avg word length',
      'Favorite starting letter',
      'Best time (daily)',
      'Average time (daily)',
    ]);
  });

  it('daily hides the peel, dump and per-Bunch-size tiles', () => {
    const daily = labels('daily');
    for (const hidden of [
      'Fastest peel',
      'Tiles peeled',
      'Tiles dumped',
      'Best time · Quick',
      'Best time · Standard',
      'Best time · Full',
    ]) {
      expect(daily).not.toContain(hidden);
    }
  });

  it('solo keeps its existing tile set', () => {
    expect(labels('solo')).toEqual([
      'Games played',
      'Current streak',
      'Longest streak',
      'Longest word',
      'Rarest word',
      'Avg word length',
      'Fastest peel',
      'Tiles peeled',
      'Tiles dumped',
      'Favorite starting letter',
      'Best time · Quick',
      'Best time · Standard',
      'Best time · Full',
    ]);
  });

  it('multiplayer keeps its existing tile set', () => {
    expect(labels('multiplayer')).toEqual([
      'Games played',
      'Wins',
      'Current streak',
      'Longest streak',
      'Longest word',
      'Rarest word',
      'Avg word length',
      'Fastest peel',
      'Tiles peeled',
      'Tiles dumped',
      'Favorite starting letter',
      'Best peel streak',
    ]);
  });

  it('all keeps its existing tile set', () => {
    expect(labels('all')).toEqual([
      'Games played',
      'Wins',
      'Current streak',
      'Longest streak',
      'Longest word',
      'Rarest word',
      'Avg word length',
      'Fastest peel',
      'Tiles peeled',
      'Tiles dumped',
      'Favorite starting letter',
      'Best peel streak',
      'Best time · Quick',
      'Best time · Standard',
      'Best time · Full',
      'Best time (daily)',
    ]);
  });
});

describe('buildStatTiles', () => {
  const valueOf = (tiles: { label: string; value: string | number }[], label: string) =>
    tiles.find((t) => t.label === label)?.value;

  it('computes daily best and average time', () => {
    const tiles = buildStatTiles(
      statsRow({ mode: 'daily', games_played: 2, daily_best_time_ms: 100_000, daily_total_time_ms: 250_000 }),
      { current: 3, longest: 5 },
      'daily',
    );
    expect(valueOf(tiles, 'Best time (daily)')).toBe('1:40');
    expect(valueOf(tiles, 'Average time (daily)')).toBe('2:05');
    expect(valueOf(tiles, 'Current streak')).toBe(3);
    expect(valueOf(tiles, 'Longest streak')).toBe(5);
  });

  it('shows a dash for the streak tiles when the profile read failed', () => {
    const tiles = buildStatTiles(statsRow({ games_played: 1 }), null, 'all');
    expect(valueOf(tiles, 'Current streak')).toBe('-');
    expect(valueOf(tiles, 'Longest streak')).toBe('-');
  });

  it('lists tied favorite letters alphabetically, capped at four', () => {
    const tiles = buildStatTiles(
      statsRow({ games_played: 1, first_letter_counts: { E: 3, B: 3, A: 3, D: 3, C: 3, F: 1 } }),
      null,
      'all',
    );
    expect(valueOf(tiles, 'Favorite starting letter')).toBe('A, B, C, D +1');
  });

  it('formats win rate and fastest peel', () => {
    const tiles = buildStatTiles(
      statsRow({ games_played: 4, games_won: 1, fastest_peel_ms: 2340 }),
      null,
      'multiplayer',
    );
    expect(valueOf(tiles, 'Wins')).toBe('1 (25%)');
    expect(valueOf(tiles, 'Fastest peel')).toBe('2.3s');
  });
});

describe('formatBestTime', () => {
  it('renders mm:ss and a dash for a missing time', () => {
    expect(formatBestTime(143_000)).toBe('2:23');
    expect(formatBestTime(undefined)).toBe('-');
  });
});
```

- [ ] **Step 4: Run the test to confirm it fails.** `npm test --workspace @plantain/web`. Expected: the suite fails with `Failed to resolve import "../src/lib/statTiles.js"` (or `Cannot find module`), because the module doesn't exist yet.

- [ ] **Step 5: Implement `statTiles.ts`.** Create `apps/web/src/lib/statTiles.ts`:

```ts
import { BUNCH_SIZE_PRESETS } from '@plantain/shared';
import type { GameMode, ProfileStatsRow } from './profile.js';

/** The Stats tab's mode pills: one per profile_stats mode, plus 'all' (client-side aggregate). */
export type StatsFilter = 'all' | GameMode;

/** Account-wide daily play streak (lives on profiles, not profile_stats). */
export interface StreakInfo {
  current: number;
  longest: number;
}

export interface StatTileDef {
  label: string;
  /** Filters this tile is shown on. A tile that can never carry information on a mode is hidden
   * there instead of showing a permanent '-' or 0. */
  modes: readonly StatsFilter[];
  value: (stats: ProfileStatsRow, streak: StreakInfo | null) => string | number;
}

export interface StatTile {
  label: string;
  value: string | number;
}

const EVERY: readonly StatsFilter[] = ['all', 'multiplayer', 'solo', 'daily'];
// Win rate and peel streak are multiplayer-only by definition (best_peel_streak is never set for
// solo/xtina rows) -- see the 2026-08-08 spec.
const COMPETITIVE: readonly StatsFilter[] = ['all', 'multiplayer'];
// Daily deals the whole puzzle at once (Bunch starts at 0) and has Dump off, so peel/dump tiles
// can never move off zero there -- 2026-10-06 spec, section 1.1.
const DRAWS: readonly StatsFilter[] = ['all', 'multiplayer', 'solo'];
// Best time per Bunch size: solo-only (multiplayer has no clock, daily has no Bunch).
const SOLO_CLOCK: readonly StatsFilter[] = ['all', 'solo'];
// Best time is safe on 'all' (min is associative). Average is daily-only: on 'all', games_played
// is summed across every mode, so dividing daily_total_time_ms by it would be silently wrong --
// see the 2026-09-24 design doc.
const DAILY_BEST: readonly StatsFilter[] = ['all', 'daily'];
const DAILY_ONLY: readonly StatsFilter[] = ['daily'];

/** mm:ss, matching Game.tsx's Timed solo elapsed-time card and Results.tsx's summary. */
export function formatBestTime(ms: number | undefined): string {
  if (ms == null) return '-';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function favoriteLetters(stats: ProfileStatsRow): string {
  const letterEntries = Object.entries(stats.first_letter_counts ?? {});
  const maxLetterCount = letterEntries.reduce((max, [, count]) => Math.max(max, count), 0);
  if (maxLetterCount === 0) return '-';
  const tiedLetters = letterEntries
    .filter(([, count]) => count === maxLetterCount)
    .map(([letter]) => letter)
    .sort();
  return tiedLetters.length > 4
    ? `${tiedLetters.slice(0, 4).join(', ')} +${tiedLetters.length - 4}`
    : tiedLetters.join(', ');
}

/** Every Stats-tab tile in display order. Visibility per mode lives on the tile itself. */
export const STAT_TILE_DEFS: readonly StatTileDef[] = [
  { label: 'Games played', modes: EVERY, value: (s) => s.games_played },
  {
    label: 'Wins',
    modes: COMPETITIVE,
    value: (s) => `${s.games_won} (${s.games_played > 0 ? Math.round((s.games_won / s.games_played) * 100) : 0}%)`,
  },
  { label: 'Current streak', modes: EVERY, value: (_s, streak) => streak?.current ?? '-' },
  { label: 'Longest streak', modes: EVERY, value: (_s, streak) => streak?.longest ?? '-' },
  { label: 'Longest word', modes: EVERY, value: (s) => s.longest_word ?? '-' },
  { label: 'Rarest word', modes: EVERY, value: (s) => s.rarest_word ?? '-' },
  {
    label: 'Avg word length',
    modes: EVERY,
    value: (s) => (s.total_words > 0 ? (s.total_word_length / s.total_words).toFixed(1) : '-'),
  },
  {
    label: 'Fastest peel',
    modes: DRAWS,
    value: (s) => (s.fastest_peel_ms != null ? `${(s.fastest_peel_ms / 1000).toFixed(1)}s` : '-'),
  },
  { label: 'Tiles peeled', modes: DRAWS, value: (s) => s.total_peels },
  { label: 'Tiles dumped', modes: DRAWS, value: (s) => s.total_dumps },
  { label: 'Favorite starting letter', modes: EVERY, value: favoriteLetters },
  {
    label: 'Best peel streak',
    modes: COMPETITIVE,
    value: (s) => ((s.best_peel_streak ?? 0) > 0 ? s.best_peel_streak : '-'),
  },
  ...BUNCH_SIZE_PRESETS.map(
    (preset): StatTileDef => ({
      label: `Best time · ${preset.label}`,
      modes: SOLO_CLOCK,
      value: (s) => formatBestTime(s.solo_best_times?.[String(preset.size)]),
    }),
  ),
  {
    label: 'Best time (daily)',
    modes: DAILY_BEST,
    value: (s) => formatBestTime(s.daily_best_time_ms ?? undefined),
  },
  {
    label: 'Average time (daily)',
    modes: DAILY_ONLY,
    value: (s) => (s.games_played > 0 ? formatBestTime(s.daily_total_time_ms / s.games_played) : '-'),
  },
];

/** The tiles shown on a filter. Data-free, so the loading skeleton can size itself from it. */
export function visibleStatTiles(filter: StatsFilter): StatTileDef[] {
  return STAT_TILE_DEFS.filter((def) => def.modes.includes(filter));
}

export function buildStatTiles(
  stats: ProfileStatsRow,
  streak: StreakInfo | null,
  filter: StatsFilter,
): StatTile[] {
  return visibleStatTiles(filter).map((def) => ({ label: def.label, value: def.value(stats, streak) }));
}
```

- [ ] **Step 6: Run the tests to confirm they pass.** `npm test --workspace @plantain/web`. Expected: `statTiles.test.ts` passes with 10 tests and 0 failures.

- [ ] **Step 7: Use it in `Profile.tsx`.** Four edits in `apps/web/src/pages/Profile.tsx`:

(a) Imports. Replace lines 3-23:

```tsx
import {
  ACHIEVEMENT_DEFS,
  ACHIEVEMENT_ORDER,
  ACCESSORY_SETS,
  validateDisplayName,
  normalizeAvatarConfig,
  type AvatarConfig,
  type AccessorySlot,
} from '@plantain/shared';
import { api, getErrorMessage } from '../lib/api.js';
import { useSessionStore } from '../store/sessionStore.js';
import {
  fetchMyStats,
  fetchMyAchievements,
  fetchMyProfile,
  guestHasProgress,
  type ProfileStatsRow,
  type AchievementRow,
} from '../lib/profile.js';
import { buildStatTiles, type StatsFilter, type StreakInfo } from '../lib/statTiles.js';
```

(b) Delete line 61 (`type StatsFilter = 'all' | GameMode;`) and the blank line after it.

(c) In `StatsBoardProps`, change `streak: { current: number; longest: number } | null;` to `streak: StreakInfo | null;`. Delete the whole `formatBestTime` function along with its doc comment (old :473-480). It now lives in `statTiles.ts`.

(d) In `StatsBoard`, replace everything from `const avgLen = ...` through the closing `];` of `const tiles` (old :512-572) with:

```tsx
  // Which tiles show on which pill is decided per tile in lib/statTiles.ts (STAT_TILE_DEFS'
  // `modes`) -- e.g. daily hides the peel/dump/Bunch-size tiles it can never move.
  const tiles = buildStatTiles(stats, streak, filter);
```

The JSX that maps `tiles` stays as it is.

- [ ] **Step 8: Typecheck.** `npm run typecheck --workspace @plantain/web`. Expected: exit 0. A `'GameMode' is declared but never used` or `'BUNCH_SIZE_PRESETS' ...` error means a leftover import. Remove it.

- [ ] **Step 9: Browser check of the Daily pill.** This needs the local stack (`npm run db:start`) and `preview_start` for `api` and `web`. Navigate to `/profile`, then read the live tab's own user id. Anonymous auth is per-tab, so never guess the "newest guest" from SQL:

```js
JSON.parse(Object.entries(sessionStorage).find(([k]) => k.endsWith('-auth-token'))[1]).user.id
```

Un-guest that profile so the mode pills render (guests get the locked veil with no selector), and seed two rows. This is local-only test data:

```bash
MSYS_NO_PATHCONV=1 docker exec supabase_db_plantain-pieces psql -U postgres -d postgres -c "
update public.profiles set is_guest = false where id = '<USER_ID>';
insert into public.profile_stats (profile_id, mode, games_played, total_peels, longest_word, longest_word_length, daily_best_time_ms, daily_total_time_ms)
values ('<USER_ID>', 'daily', 2, 0, 'PLATES', 6, 100000, 250000),
       ('<USER_ID>', 'solo', 3, 40, 'BANANA', 6, null, 0)
on conflict (profile_id, mode) do update set games_played = excluded.games_played;"
```

Reload `/profile`, click the **Stats** tab, then click the **Daily** pill. Run:

```js
[...document.querySelectorAll('.stats-grid .stat-label')].map((e) => e.textContent)
```

Expected: exactly the nine daily labels from Step 3, in that order, with values `1:40` (Best time (daily)) and `2:05` (Average time (daily)). Click **Solo** and expect the 13 solo labels.

- [ ] **Step 10: Commit.**

```bash
git add apps/web/package.json package-lock.json apps/web/src/lib/statTiles.ts apps/web/test/fixtures.ts apps/web/test/statTiles.test.ts apps/web/src/pages/Profile.tsx
git commit -m "$(cat <<'EOF'
fix(stats): hide peel/dump/Bunch-size tiles on the Daily filter

Daily deals the whole puzzle at once with Dump off, so Fastest peel, Tiles
peeled/dumped and the three per-Bunch-size best times could never carry
information there. Tile visibility moves to a per-tile `modes` list in
lib/statTiles.ts (with vitest coverage, the first in apps/web) instead of
scattered show* flags.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Stats tab: fetch once, derive per mode, skeleton while loading (spec 1.2 + 1.3)

**Files:**
- Create: `apps/web/src/lib/statsView.ts`
- Create: `apps/web/test/statsView.test.ts`
- Modify: `apps/web/src/lib/profile.ts:76-159` (move `aggregateStats` out, add `fetchMyStatsRows`, simplify `fetchMyStats`)
- Modify: `apps/web/src/pages/Profile.tsx:1` (React import), `:14-23` (imports), `:72-86` (state + effects), `:114-123` (StatsBoard props), `StatsBoardProps`, `StatsBoard` (loading branch)

**Interfaces:**
- Consumes: `StatsFilter`, `visibleStatTiles` (Task 3); `ProfileStatsRow` (`profile.ts`).
- Produces:
  - `apps/web/src/lib/statsView.ts`: `export function aggregateStats(rows: readonly ProfileStatsRow[]): ProfileStatsRow | null` and `export function deriveStatsView(rows: readonly ProfileStatsRow[], filter: StatsFilter): ProfileStatsRow | null`
  - `apps/web/src/lib/profile.ts`: `export async function fetchMyStatsRows(): Promise<ProfileStatsRow[]>`, plus `export async function fetchMyStats(): Promise<ProfileStatsRow | null>` (the mode parameter is removed; its only remaining caller, `guestHasProgress`, never passed one)
  - `StatsBoardProps.loading?: boolean`

- [ ] **Step 1: Write the failing test.** Create `apps/web/test/statsView.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { aggregateStats, deriveStatsView } from '../src/lib/statsView.js';
import { statsRow } from './fixtures.js';

const multi = statsRow({
  mode: 'multiplayer',
  games_played: 5,
  games_won: 2,
  total_peels: 30,
  longest_word: 'BANANA',
  longest_word_length: 6,
  fastest_peel_ms: 4000,
});
const solo = statsRow({
  mode: 'solo',
  games_played: 3,
  total_peels: 12,
  longest_word: 'PLANTAINS',
  longest_word_length: 9,
  fastest_peel_ms: 2500,
  solo_best_times: { '54': 143000 },
});

describe('deriveStatsView', () => {
  it("'all' aggregates across every mode row", () => {
    const view = deriveStatsView([multi, solo], 'all');
    expect(view?.games_played).toBe(8);
    expect(view?.total_peels).toBe(42);
    expect(view?.longest_word).toBe('PLANTAINS');
    expect(view?.fastest_peel_ms).toBe(2500);
    expect(view?.solo_best_times).toEqual({ '54': 143000 });
  });

  it('a specific mode returns that mode row unchanged', () => {
    expect(deriveStatsView([multi, solo], 'solo')).toBe(solo);
    expect(deriveStatsView([multi, solo], 'multiplayer')).toBe(multi);
  });

  it('a mode never played is null, not another mode', () => {
    expect(deriveStatsView([multi, solo], 'daily')).toBeNull();
  });

  it('no rows is null for every filter', () => {
    for (const f of ['all', 'multiplayer', 'solo', 'daily'] as const) {
      expect(deriveStatsView([], f)).toBeNull();
    }
  });
});

describe('aggregateStats', () => {
  it('returns a lone row as-is', () => {
    expect(aggregateStats([solo])).toBe(solo);
  });

  it('takes the minimum daily best time and sums daily total time', () => {
    const a = statsRow({ mode: 'daily', daily_best_time_ms: 90000, daily_total_time_ms: 200000 });
    const b = statsRow({ mode: 'solo', daily_best_time_ms: null, daily_total_time_ms: 0 });
    const view = aggregateStats([a, b]);
    expect(view?.daily_best_time_ms).toBe(90000);
    expect(view?.daily_total_time_ms).toBe(200000);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails.** `npm test --workspace @plantain/web`. Expected: `statsView.test.ts` fails with `Failed to resolve import "../src/lib/statsView.js"`, while `statTiles.test.ts` still passes.

- [ ] **Step 3: Create `statsView.ts`, moving `aggregateStats` verbatim.** Create `apps/web/src/lib/statsView.ts`. It contains the existing `aggregateStats` body from `profile.ts:76-139`, unchanged except that it's exported and takes `readonly` rows, plus `deriveStatsView`:

```ts
import type { ProfileStatsRow } from './profile.js';
import type { StatsFilter } from './statTiles.js';

/** Merges multiple per-mode rows into one aggregate: sums the additive counters, min/max the
 * extremal ones, and sums first_letter_counts per letter. Used for the Stats tab's default "All
 * modes" view. Pure (no Supabase import) so it's unit-testable. */
export function aggregateStats(rows: readonly ProfileStatsRow[]): ProfileStatsRow | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];

  let longest: ProfileStatsRow['longest_word'] = null;
  let longestLen = 0;
  let rarest: ProfileStatsRow['rarest_word'] = null;
  let rarestScore = 0;
  let fastestPeel: number | null = null;
  let bestStreak = 0;
  const letterCounts: Record<string, number> = {};
  const bestTimes: Record<string, number> = {};
  let dailyBestMs: number | null = null;
  let dailyTotalMs = 0;
  for (const r of rows) {
    if (r.longest_word_length > longestLen) {
      longestLen = r.longest_word_length;
      longest = r.longest_word;
    }
    if (r.rarest_word_score > rarestScore) {
      rarestScore = r.rarest_word_score;
      rarest = r.rarest_word;
    }
    if (r.fastest_peel_ms != null && (fastestPeel == null || r.fastest_peel_ms < fastestPeel)) {
      fastestPeel = r.fastest_peel_ms;
    }
    bestStreak = Math.max(bestStreak, r.best_peel_streak ?? 0);
    for (const [letter, count] of Object.entries(r.first_letter_counts ?? {})) {
      letterCounts[letter] = (letterCounts[letter] ?? 0) + count;
    }
    // Only the 'solo' row ever populates this, but merging key-wise (min) rather than just
    // taking that row means no mode-specific branch is needed here either.
    for (const [bunchSize, ms] of Object.entries(r.solo_best_times ?? {})) {
      bestTimes[bunchSize] = bestTimes[bunchSize] != null ? Math.min(bestTimes[bunchSize], ms) : ms;
    }
    if (r.daily_best_time_ms != null) {
      dailyBestMs = dailyBestMs == null ? r.daily_best_time_ms : Math.min(dailyBestMs, r.daily_best_time_ms);
    }
    dailyTotalMs += r.daily_total_time_ms ?? 0;
  }

  return {
    profile_id: rows[0].profile_id,
    mode: 'multiplayer', // placeholder -- callers requesting the aggregate ignore this field
    games_played: rows.reduce((sum, r) => sum + r.games_played, 0),
    games_won: rows.reduce((sum, r) => sum + r.games_won, 0),
    total_peels: rows.reduce((sum, r) => sum + r.total_peels, 0),
    total_dumps: rows.reduce((sum, r) => sum + r.total_dumps, 0),
    total_words: rows.reduce((sum, r) => sum + r.total_words, 0),
    total_word_length: rows.reduce((sum, r) => sum + r.total_word_length, 0),
    longest_word: longest,
    longest_word_length: longestLen,
    fastest_peel_ms: fastestPeel,
    rarest_word: rarest,
    rarest_word_score: rarestScore,
    best_peel_streak: bestStreak,
    first_letter_counts: letterCounts,
    solo_best_times: bestTimes,
    daily_best_time_ms: dailyBestMs,
    daily_total_time_ms: dailyTotalMs,
  };
}

/** The Stats tab's view for one pill, derived synchronously from every row the caller owns:
 * the aggregate for 'all', otherwise that mode's own row (null if never played). Switching pills
 * is therefore a pure recompute, with no fetch and so no out-of-order reply to race. */
export function deriveStatsView(
  rows: readonly ProfileStatsRow[],
  filter: StatsFilter,
): ProfileStatsRow | null {
  if (filter === 'all') return aggregateStats(rows);
  return rows.find((r) => r.mode === filter) ?? null;
}
```

- [ ] **Step 4: Run the tests to confirm they pass.** `npm test --workspace @plantain/web`. Expected: both files pass, 16 tests in total.

- [ ] **Step 5: Rewire `profile.ts`.** In `apps/web/src/lib/profile.ts`, delete the old `aggregateStats` (its doc comment plus :76-139) and the old `fetchMyStats` (:141-159). Put this in their place:

```ts
/** Every profile_stats row the caller owns, one per mode played. Empty when signed out, never
 * played, or the read failed; the Stats tab treats all three as "no games yet". */
export async function fetchMyStatsRows(): Promise<ProfileStatsRow[]> {
  const id = await myId();
  if (!id) return [];
  const { data, error } = await supabase.from('profile_stats').select('*').eq('profile_id', id);
  if (error) return [];
  return data as ProfileStatsRow[];
}

/** Aggregate across all of the caller's mode rows ("All modes"). */
export async function fetchMyStats(): Promise<ProfileStatsRow | null> {
  return aggregateStats(await fetchMyStatsRows());
}
```

and add to the import block at the top of `profile.ts`:

```ts
import { aggregateStats } from './statsView.js';
```

(`statsView.ts` imports only types from `profile.ts`, so the cycle is erased at compile time.)

- [ ] **Step 6: Load once in `Profile`.** In `apps/web/src/pages/Profile.tsx`:

(a) In the `../lib/profile.js` import block, replace `fetchMyStats,` with `fetchMyStatsRows,`, and change the statTiles import to:

```tsx
import { buildStatTiles, visibleStatTiles, type StatsFilter, type StreakInfo } from '../lib/statTiles.js';
import { deriveStatsView } from '../lib/statsView.js';
```

(b) Replace the state and effects at `:72-86` (from `const [statsFilter, ...` through the closing `}, []);` of the profile/achievements effect) with:

```tsx
  const [statsFilter, setStatsFilter] = useState<StatsFilter>('all');
  // Every profile_stats row the caller owns (one per mode played), fetched once. Each pill is a
  // synchronous derivation, so a click never waits on the network or races an earlier reply.
  const [statsRows, setStatsRows] = useState<ProfileStatsRow[]>([]);
  const [streak, setStreak] = useState<StreakInfo | null>(null);
  // Distinct from "loaded, no games": while true the Stats tab renders a same-size skeleton
  // grid, not the empty-state message that used to swap out for the full grid on first load.
  const [statsLoading, setStatsLoading] = useState(true);
  const [achievements, setAchievements] = useState<AchievementRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Streak lives on profiles, stats on profile_stats. Both must land before the grid renders,
    // or the two streak tiles pop in after the rest.
    Promise.all([fetchMyStatsRows(), fetchMyProfile()]).then(([rows, profile]) => {
      if (cancelled) return;
      setStatsRows(rows);
      setStreak(profile ? { current: profile.current_streak, longest: profile.longest_streak } : null);
      setStatsLoading(false);
    });
    fetchMyAchievements().then((a) => {
      if (!cancelled) setAchievements(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = useMemo(() => deriveStatsView(statsRows, statsFilter), [statsRows, statsFilter]);
```

(c) In the `<StatsBoard ... />` element (:116-122), add `loading={statsLoading}` after `streak={streak}`.

(d) In `StatsBoardProps`, add after `locked?: boolean;`:

```tsx
  /** True until stats AND streak have both loaded: render a skeleton the same size as the real
   * grid for this filter instead of the empty state. */
  loading?: boolean;
```

(e) Change the `StatsBoard` signature to destructure `loading = false`:

```tsx
function StatsBoard({ stats, streak, filter, onFilterChange, locked = false, loading = false }: StatsBoardProps) {
```

and insert this directly above the existing `if (!stats || stats.games_played === 0) {`:

```tsx
  if (loading) {
    // Same tile count and labels as the real grid for this filter (visibleStatTiles is
    // data-free); .skeleton-bar sits inside .stat-value so the line box -- and so the tile
    // height -- matches a real value.
    return (
      <div className="panel profile-panel">
        {modeSelector}
        <div className="stats-grid" aria-busy="true">
          {visibleStatTiles(filter).map((def) => (
            <div key={def.label} className="stat-tile" aria-hidden="true">
              <span className="stat-value">
                <span className="skeleton-bar" />
              </span>
              <span className="stat-label">{def.label}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
```

- [ ] **Step 7: Typecheck and tests.** Run `npm run typecheck --workspace @plantain/web` and `npm test --workspace @plantain/web`. Expected: typecheck exits 0 and 16 tests pass.

- [ ] **Step 8: Browser check: no resize on load, no network on pill switch.** You need the stack and the `api`/`web` previews, plus a profile un-guested and seeded with the `daily` and `solo` rows as in Task 3 Step 9. Re-run that step's SQL against the current tab's id if this is a new tab. On `/profile`, run this. It delays only the two Stats reads, remounts the page through the router (no reload, so the patch survives), opens the Stats tab, and samples the panel every 50ms:

```js
await (async () => {
  document.head.insertAdjacentHTML('beforeend', '<style>*{transition:none!important;animation:none!important}</style>');
  const realFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/rest/v1/profile_stats') || url.includes('/rest/v1/profiles')) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    return realFetch(input, init);
  };
  const go = (path) => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  go('/'); await wait(150);
  go('/profile'); await wait(50);
  [...document.querySelectorAll('.profile-tab')].find((b) => b.textContent.trim() === 'Stats').click();
  const samples = [];
  for (let i = 0; i < 50; i++) {
    const panel = document.querySelector('.profile-panel');
    samples.push({
      h: panel ? Math.round(panel.getBoundingClientRect().height) : null,
      skeleton: !!document.querySelector('.stats-grid[aria-busy="true"]'),
      tiles: document.querySelectorAll('.stats-grid .stat-tile').length,
    });
    await wait(50);
  }
  window.fetch = realFetch;
  return {
    heights: [...new Set(samples.map((s) => s.h).filter((h) => h != null))],
    tileCounts: [...new Set(samples.map((s) => s.tiles))],
    sawSkeleton: samples.some((s) => s.skeleton),
    sawReal: samples.some((s) => !s.skeleton && s.tiles > 0),
    sawEmptyState: samples.some((s) => s.tiles === 0 && s.h != null),
  };
})()
```

Expected: `sawSkeleton: true`, `sawReal: true`, `sawEmptyState: false`, `tileCounts` is `[16]` (the 'all' set), and `heights` has exactly **one** value. If a long seeded word wraps a tile and makes the heights differ, re-seed with a 6-letter word and re-run before concluding anything. Then check pill switching:

```js
(() => {
  const realFetch = window.fetch;
  let statsRequests = 0;
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/rest/v1/profile_stats')) statsRequests++;
    return realFetch(input, init);
  };
  const pill = (name) => [...document.querySelectorAll('.segmented-option')].find((b) => b.textContent.trim() === name);
  const labelsNow = () => [...document.querySelectorAll('.stats-grid .stat-label')].map((e) => e.textContent);
  pill('Daily').click();
  const daily = labelsNow();
  pill('Solo').click();
  const solo = labelsNow();
  pill('All').click();
  const all = labelsNow();
  window.fetch = realFetch;
  return { statsRequests, daily: daily.length, solo: solo.length, all: all.length };
})()
```

Expected: `{ statsRequests: 0, daily: 9, solo: 13, all: 16 }`. Reading the DOM right after each `.click()` shows the new mode immediately, because React flushes discrete click updates synchronously, which proves the switch is synchronous.

- [ ] **Step 9: Commit.**

```bash
git add apps/web/src/lib/statsView.ts apps/web/test/statsView.test.ts apps/web/src/lib/profile.ts apps/web/src/pages/Profile.tsx
git commit -m "$(cat <<'EOF'
fix(stats): fetch stats once and derive each mode pill client-side

Every pill click refetched with no loading state or stale-response guard, so
old numbers lingered and an out-of-order reply could win. Now all of the
caller's profile_stats rows load once alongside the profile (streak), each
pill is a synchronous deriveStatsView(), and a same-size skeleton grid
replaces the empty-state flash on first load.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Daily Results: parallel loads, no achievement polling, fixed-size placeholders (spec 1.4)

**Files:**
- Create: `apps/web/src/lib/resultsPlan.ts`
- Create: `apps/web/test/resultsPlan.test.ts`
- Modify: `apps/web/src/pages/Results.tsx:1-11` (import), `:31-37` (state), `:48-120` (players / achievements / boards effects), `:144-145` (summary guard), `:180` (`gameReady`), `:275-409` (streak pill, panels, board window)
- Modify: `apps/web/src/styles.css` (new `.reserve-space` + `.results-board-window-placeholder` rules after `.results-board-window:hover:not(:disabled)` ~:1655)

**Interfaces:**
- Consumes: `PublicRoom['mode']` (`apps/web/src/lib/rooms.ts:23`, type-only).
- Produces: `export interface ResultsFetchPlan { achievements: boolean; achievementRechecksMs: readonly number[]; dailySummary: boolean }` and `export function resultsFetchPlan(mode: PublicRoom['mode']): ResultsFetchPlan`. Also the CSS classes `.reserve-space` and `.results-board-window-placeholder`.

- [ ] **Step 1: Write the failing test.** Create `apps/web/test/resultsPlan.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resultsFetchPlan } from '../src/lib/resultsPlan.js';

describe('resultsFetchPlan', () => {
  it('daily skips achievements and their re-polls entirely, and fetches the daily summary', () => {
    expect(resultsFetchPlan('daily')).toEqual({
      achievements: false,
      achievementRechecksMs: [],
      dailySummary: true,
    });
  });

  it.each(['multiplayer', 'solo', 'xtina'] as const)('%s polls achievements at 0/400/1000ms, no daily summary', (mode) => {
    expect(resultsFetchPlan(mode)).toEqual({
      achievements: true,
      achievementRechecksMs: [400, 1000],
      dailySummary: false,
    });
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails.** `npm test --workspace @plantain/web`. Expected: `resultsPlan.test.ts` fails with `Failed to resolve import "../src/lib/resultsPlan.js"`, while the other two files pass.

- [ ] **Step 3: Implement `resultsPlan.ts`.** Create `apps/web/src/lib/resultsPlan.ts`:

```ts
import type { PublicRoom } from './rooms.js';

/** Which of the Results page's mode-dependent fetches run. Everything not listed here (players,
 * boards) runs for every mode, starting on mount. */
export interface ResultsFetchPlan {
  /** Read this player's achievements for ones unlocked by this room. */
  achievements: boolean;
  /** Delays (ms) of the re-reads after the immediate one; the last is final. */
  achievementRechecksMs: readonly number[];
  /** Fetch the daily beat-percent / personal-best summary. */
  dailySummary: boolean;
}

export function resultsFetchPlan(mode: PublicRoom['mode']): ResultsFetchPlan {
  if (mode === 'daily') {
    // Every achievement the re-poll could surface is peel/dump/opponent based, and a daily game
    // has no Bunch to peel, no Dump and no opponent -- 2026-10-06 spec, section 1.4.
    return { achievements: false, achievementRechecksMs: [], dailySummary: true };
  }
  // Re-checks catch the word-based achievements the client's own summary (submitSummaryOnce in
  // Game.tsx) lands a beat after the game ends -- usually well under a second.
  return { achievements: true, achievementRechecksMs: [400, 1000], dailySummary: false };
}
```

- [ ] **Step 4: Run the tests to confirm they pass.** `npm test --workspace @plantain/web`. Expected: all three files pass, 20 tests.

- [ ] **Step 5: Restructure the Results effects.** In `apps/web/src/pages/Results.tsx`:

(a) Add the import after the `../lib/boards.js` import:

```tsx
import { resultsFetchPlan } from '../lib/resultsPlan.js';
```

(b) Add this state after `const [boardCount, setBoardCount] = useState(0);`:

```tsx
  // True once the board read has a real answer (our board's words resolved) or its final retry
  // ran. Until then the board window and the Longest word value hold placeholders.
  const [boardsSettled, setBoardsSettled] = useState(false);
```

(c) Replace the players/achievements effect **and** the boards effect (old :48-120, from the `// This game's numbers come from the ROOM` comment through the boards effect's closing `}, [roomId, profileId]);`) with:

```tsx
  const roomMode = room?.mode;

  // `me` only feeds the Tiles tile, which is final the moment the game ends, so one read is
  // enough. It needs nothing from the room, so it starts on mount alongside fetchRoom.
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    fetchPlayers(roomId).then((players) => {
      if (!cancelled) setMe(players.find((p) => p.profile_id === profileId) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [roomId, profileId]);

  // This game's achievements are matched on the roomId their meta carries (nothing per-game is
  // stored, migration 20260728000006). The mode decides whether to look at all: daily can't
  // unlock any of them, so it skips the read and its re-polls entirely (resultsFetchPlan).
  useEffect(() => {
    if (!roomId || !roomMode) return;
    const plan = resultsFetchPlan(roomMode);
    if (!plan.achievements) {
      setAchievementsSettled(true);
      return;
    }
    let cancelled = false;
    setAchievementsSettled(false);
    // `cancelled` only guards post-unmount updates. `latestSeq` stops a slow, earlier-issued
    // read from resolving after a later one and reverting to an incomplete snapshot.
    let latestSeq = 0;
    const rechecks = plan.achievementRechecksMs;
    async function load(isFinal: boolean) {
      const seq = ++latestSeq;
      const achievements = await fetchMyAchievements();
      if (cancelled || seq !== latestSeq) return;
      setEarned(
        achievements
          .filter((a) => (a.meta as { roomId?: string })?.roomId === roomId)
          .map((a) => a.type),
      );
      if (isFinal) setAchievementsSettled(true);
    }
    load(rechecks.length === 0);
    const timers = rechecks.map((ms, i) => setTimeout(() => load(i === rechecks.length - 1), ms));
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [roomId, roomMode]);

  // Your own final board, for the preview window. Retried once at 1000ms because every client
  // persists its board asynchronously right as the game ends, including this one. Needs nothing
  // from the room, so it starts on mount.
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    // Same ordering guard as the achievements effect above.
    let latestSeq = 0;
    async function load(isFinal: boolean) {
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
      if (mine || isFinal) setBoardsSettled(true);
    }
    load(false);
    const t = setTimeout(() => load(true), 1000);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [roomId, profileId]);
```

(d) In the daily-summary effect, replace its first line

```tsx
    if (!room || room.mode !== 'daily' || room.status !== 'finished') return;
```

with

```tsx
    if (!room || !resultsFetchPlan(room.mode).dailySummary || room.status !== 'finished') return;
```

(Leave the streak-recording effect alone. It already fires as soon as `room` lands, in parallel with the summary effect.)

(e) After `const isDaily = room.mode === 'daily';` add:

```tsx
  // Daily's "Your game" panel shows nothing that comes from `me` (no Tiles tile), so it renders
  // as soon as the room does, instead of waiting on the players read.
  const gameReady = isDaily || me != null;
```

- [ ] **Step 6: Fixed-size placeholders in the JSX.** In the returned JSX of `Results.tsx`:

(a) Replace the streak pill block

```tsx
      {isDaily && streak > 0 && (
        <div className="daily-streak-update">
          🔥 {streak}-day streak!
        </div>
      )}
```

with

```tsx
      {/* Rendered (invisible) before the streak is recorded, so its arrival can't push the
          page down. Phase 2 removes this pill entirely. */}
      {isDaily && (
        <div className={`daily-streak-update${streak > 0 ? '' : ' reserve-space'}`} aria-hidden={streak === 0}>
          🔥 {streak}-day streak!
        </div>
      )}
```

(b) Change `{!me && (` (skeleton panel) to `{!gameReady && (`, and `{me && (` (real panel) to `{gameReady && (`.

(c) In the real panel, replace the Tiles value `{me.tile_count}` with `{me?.tile_count ?? '-'}`, and the Longest word value `{longestWord ?? '-'}` with:

```tsx
{longestWord ?? (boardsSettled ? '-' : <span className="skeleton-bar" />)}
```

(d) Replace the whole `{isDaily && ( <div className="daily-beat-percent"> ... </div> )}` block with one where the pill and the personal-best line are **always** in the DOM and only their content or visibility changes:

```tsx
          {isDaily && (
            <div className="daily-beat-percent">
              {/* One pill box in every state (loading, ranked, first solver, unavailable), so the
                  panel's height is fixed before the summary lands. */}
              <span
                className={`daily-streak-update${dailySummary && !dailySummary.available ? ' reserve-space' : ''}`}
                aria-hidden={dailySummary != null && !dailySummary.available}
              >
                {!dailySummary ? (
                  <>
                    Checking today's rankings… <span className="skeleton-bar" />
                  </>
                ) : dailySummary.beatPercent != null ? (
                  `Beat ${dailySummary.beatPercent}% of today's players`
                ) : (
                  'Be the first to solve today!'
                )}
              </span>
              <span
                className={`daily-personal-best${dailySummary?.isPersonalBest ? '' : ' reserve-space'}`}
                aria-hidden={!dailySummary?.isPersonalBest}
              >
                New personal best!
              </span>
            </div>
          )}
```

(e) Directly above `{myBoard && (` (the board window button), insert the placeholder:

```tsx
      {/* Same shell, title and fixed-height frame as the real window below, so the board
          landing swaps content in place instead of inserting a box. */}
      {!myBoard && !boardsSettled && (
        <div className="results-board-window results-board-window-placeholder" aria-hidden="true">
          <span className="results-board-window-head">
            <span className="results-board-window-title">
              {isSolo || isDaily ? 'Your board' : "Everyone's boards"}
            </span>
            <span className="results-board-window-hint">
              <span className="skeleton-bar" />
            </span>
          </span>
          <span className="results-board-window-frame" />
        </div>
      )}
```

- [ ] **Step 7: Add the two CSS rules.** In `apps/web/src/styles.css`, right after the `.results-board-window:hover:not(:disabled) { ... }` rule (~:1655), add:

```css
/* Results: holds a section's final footprint before its data lands (spec 1.4). visibility, not
   display, so the box keeps its size. */
.reserve-space {
  visibility: hidden;
}

/* A <div>, not the real window's <button>: nothing to click until the board arrives. */
.results-board-window-placeholder {
  cursor: default;
}
```

- [ ] **Step 8: Typecheck and tests.** `npm run typecheck --workspace @plantain/web` should exit 0, and `npm test --workspace @plantain/web` should pass 20 tests.

- [ ] **Step 9: Get a finished daily room.** With the stack and the `api`/`web` previews running, reuse the daily room from Task 2 Step 2. If you need a new one, seed the puzzle first:

```bash
MSYS_NO_PATHCONV=1 docker exec supabase_db_plantain-pieces psql -U postgres -d postgres -c "
insert into public.daily_puzzles
  (language, letter_multiset, grid_state, dictionary_config, floor_score, spread_score,
   distinct_board_count, replay_run_count, status, scheduled_date, generation_seed, first_word)
select 'en', 'PLANTAINSAREGREATFUNX', '{}'::jsonb,
       '{\"minLength\":2,\"maxLength\":null,\"baseEnabled\":true,\"excludedTopics\":[],\"customSetIds\":[]}'::jsonb,
       1.0, 0.5, 1, 1, 'scheduled', d::date, 1, 'PROBE'
from generate_series(current_date - 1, current_date + 1, interval '1 day') as d
where not exists (select 1 from public.daily_puzzles p where p.language = 'en' and p.scheduled_date = d::date);"
```

Then start one from `/daily` and read `<ROOM_ID>` from `location.pathname`. Force-finish it. This is local test data only; solving the puzzle by hand isn't needed to exercise the page:

```bash
MSYS_NO_PATHCONV=1 docker exec supabase_db_plantain-pieces psql -U postgres -d postgres -c "
update public.rooms set status = 'finished', finished_at = now(), winner_id = host_id where id = '<ROOM_ID>';"
```

For the non-daily regression, list a finished non-daily room, or finish a solo room started from `/solo` the same way:

```bash
MSYS_NO_PATHCONV=1 docker exec supabase_db_plantain-pieces psql -U postgres -d postgres -c "
select id, mode from public.rooms where status = 'finished' order by finished_at desc limit 5;"
```

- [ ] **Step 10: Browser check: no shift, no achievement reads on daily.** Navigate to `/room/<ROOM_ID>/results` and run the snippet below. It delays the boards, players and summary reads by 1200ms, remounts the page through the router, and samples each section's top/height every 50ms:

```js
await (async () => {
  document.head.insertAdjacentHTML('beforeend', '<style>*{transition:none!important;animation:none!important}</style>');
  const roomId = location.pathname.split('/')[2];
  const realFetch = window.fetch;
  const hits = { achievements: 0 };
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/rest/v1/achievements')) hits.achievements++;
    if (/room_boards_public|room_players_public|result-summary/.test(url)) {
      await new Promise((r) => setTimeout(r, 1200));
    }
    return realFetch(input, init);
  };
  const go = (path) => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  go('/'); await wait(150);
  go(`/room/${roomId}/results`);
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return `${Math.round(r.top)}/${Math.round(r.height)}`;
  };
  const samples = [];
  for (let i = 0; i < 70; i++) {
    samples.push({
      earned: rect('.results-earned'),
      board: rect('.results-board-window'),
      beat: rect('.daily-beat-percent'),
      back: rect('.centered > button:last-child'),
    });
    await wait(50);
  }
  window.fetch = realFetch;
  const distinct = (k) => [...new Set(samples.map((s) => s[k]).filter(Boolean))];
  return {
    earned: distinct('earned'),
    board: distinct('board'),
    beat: distinct('beat'),
    back: distinct('back'),
    achievementsRequests: hits.achievements,
  };
})()
```

Expected on the **daily** room: `earned`, `board`, `beat` and `back` each hold exactly **one** `top/height` value, and `achievementsRequests: 0`. The first samples taken while `rooms_public` is still loading show `null` and are filtered out.

Expected on a **non-daily** room: `achievementsRequests: 3` (0/400/1000ms) and `board` holds one value. `earned` may still change once, when the pre-existing "Checking achievements…" row resolves to nothing. That's outside 1.4, so record it as observed but don't fail on it.

- [ ] **Step 11: Clean up the local fixtures.**

```bash
MSYS_NO_PATHCONV=1 docker exec supabase_db_plantain-pieces psql -U postgres -d postgres -c "
delete from public.rooms where id = '<ROOM_ID>';
delete from public.daily_results where puzzle_id in (select id from public.daily_puzzles where first_word = 'PROBE');
delete from public.daily_puzzles where first_word = 'PROBE';"
```

- [ ] **Step 12: Commit.**

```bash
git add apps/web/src/lib/resultsPlan.ts apps/web/test/resultsPlan.test.ts apps/web/src/pages/Results.tsx apps/web/src/styles.css
git commit -m "$(cat <<'EOF'
fix(results): load daily results in parallel without layout shift

Daily skips the achievement read and its 400/1000ms re-polls (nothing it
can unlock is in that set), its "Your game" panel no longer waits on the
players read, and the streak pill, beat-percent pill, personal-best line,
Longest word and board window all hold fixed-size placeholders until their
data lands. Mode-dependent fetches are decided by resultsFetchPlan().

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

| Spec | Task | Coverage check |
|---|---|---|
| 1.1 Daily filter hides meaningless tiles | Task 3 | The six named tiles (Fastest peel, Tiles peeled, Tiles dumped, Best time · Quick/Standard/Full) are hidden on `daily`. The kept set is exactly the nine listed in the spec, asserted by `statTiles.test.ts`. Implemented as a per-tile `modes` predicate (`STAT_TILE_DEFS`), not a second hard-coded list; `showCompetitiveStats` and the other `show*` flags are folded into the same predicate. The Achievements tab is untouched. |
| 1.2 Delayed values on pill switch | Task 4 | `fetchMyStatsRows()` loads all rows once and `deriveStatsView()` picks the row or reuses `aggregateStats` for "All". Pill switches make no network call; Step 8 asserts `statsRequests: 0`. Refetch only on mount. |
| 1.3 Size settles after first load | Task 4 | Explicit `statsLoading`, a skeleton grid sized from `visibleStatTiles(filter)` that reuses `.skeleton-bar`, the empty state only after load with zero games, and profile and stats loaded with `Promise.all` before the grid renders. Step 8 asserts a single panel height and `sawEmptyState: false`. |
| 1.4 Daily Results slow | Task 5 | Players and boards start on mount; achievements and summary start as soon as the room lands, in parallel. Daily skips achievements and re-polls (`resultsFetchPlan`, unit-tested; Step 10 asserts 0 requests). Fixed-size placeholders cover the streak pill, beat pill, personal-best line, Longest word and board window (Step 10 asserts one rect per section). |
| 1.5 Empty tray grows | Task 1 | `.tile-rack` `min-height` = one chip row + padding via `--rack-row-h`, restated at ≥1024px, capped in landscape. The empty hint is centred via `.tile-rack.empty`. The measurement covers empty / pending / one / full row at five viewports. |
| 1.6 No Bunch indicator on daily | Task 2 | The card isn't rendered when `isDaily` (no placeholder card). The elapsed card takes the space on desktop (it's already `flex: 1`) and on mobile (the `.no-bunch` rule). |

Gaps found and fixed inline while writing:
- **Landscape conflict.** `min-height` beats `max-height`, so a plain 66px floor would have grown the landscape tray past its 18vh cap. Fixed with `min(var(--rack-row-h), 18vh)`. The large+landscape overlap is covered because the custom property comes from the large block.
- **Mobile topbar hole on daily.** Removing the card would have left the actions card alone on row 1. Fixed with the `.game-topbar.no-bunch .topbar-elapsed-card` rule.
- **Streak tiles.** They were previously omitted when the profile read failed, which would make the skeleton and real counts disagree. They now always render, with a value of `'-'`, so the skeleton's tile count always matches.
- **Breaking-signature check.** `fetchMyStats` loses its `mode` parameter. The only callers are `Profile.tsx` (moved to `fetchMyStatsRows`) and `guestHasProgress` (never passed a mode).
- **apps/web had no test runner.** It's added in Task 3 Step 1, the first task that needs it, with tests under `apps/web/test/` so `tsconfig`'s `src`-only include and the typecheck stay unaffected.
