# Polish pass, solo peel batches, landing tweaks, easter eggs + mystery achievements

**Date:** 2026-10-06
**Status:** Approved in brainstorming, awaiting spec review
**Out of scope (own phase/spec later):** the "paper design" expansion (Profile page, share
text, possibly Results). Recorded at the end so it isn't lost.

---

## Phase 1 — Bug fixes

### 1.1 Daily filter shows meaningless stat tiles
**Where:** `apps/web/src/pages/Profile.tsx` `StatsBoard` (tile list ~:555-572).

The daily puzzle deals the whole 21-tile puzzle at once (bunch starts at 0) and Dump is off,
so on the **Daily** filter these tiles can never carry information:
Fastest peel, Tiles peeled, Tiles dumped, Best time · Quick / Standard / Full.

**Change:** hide those six tiles when `filter === 'daily'`. Daily keeps: Games played, Current
streak, Longest streak, Longest word, Rarest word, Avg word length, Favorite starting letter,
Best time (daily), Average time (daily). Implement as a per-tile `modes` predicate next to the
existing `showCompetitiveStats` gating, not as a second hard-coded list.

The Profile **Achievements** tab is not per-mode and is unchanged.

### 1.2 Stats tab: delayed values when switching mode pills
**Where:** `Profile.tsx:72-79`, `apps/web/src/lib/profile.ts` `fetchMyStats`.

**Cause:** every pill click issues a fresh fetch with no cache, no loading state, and no
stale-response guard — the old mode's numbers stay up until the new request lands, and an
out-of-order reply can overwrite a newer one.

**Change:** fetch **all** of the caller's `profile_stats` rows once (new
`fetchMyStatsRows()`), and derive each mode's view client-side. "All" already aggregates across
rows; reuse that aggregation, and pick the single row for a specific mode. Pill switches become
synchronous — no network, no race. Refetch only on mount (and after a game, which already
remounts the page).

### 1.3 Stats tab: size settles after first load
**Cause:** while `stats === null` the panel renders the empty-state message, then swaps to the
full grid; streak tiles arrive separately from `fetchMyProfile`.

**Change:**
- Introduce an explicit `loading` state distinct from "loaded, no data". While loading, render a
  **skeleton grid** with the same tile count and tile dimensions as the real grid for the
  current filter (reuse `.skeleton-bar`).
- Show the "Play a game…" empty state only once loaded with zero games.
- Load profile (streak) and stats in parallel and render the grid only when both resolve, so
  streak tiles never pop in.

### 1.4 Daily Results page slow to render
**Where:** `apps/web/src/pages/Results.tsx`.

**Cause:** gated waterfall — `fetchRoom` blocks the whole page, then players + achievements
(re-polled at 400ms/1000ms), boards + word resolution (0/1000ms), and
`getDailyResultSummary` (0/1000ms). The streak pill only appears after the room loads.

**Change:**
- After `fetchRoom` resolves, fire every remaining fetch in parallel (`Promise.all` style
  effects, no serial dependency where none is needed).
- On daily, **skip the achievement fetch and its 400/1000ms re-polls entirely** — the six
  standard achievements that daily could theoretically touch are peel/dump/opponent based and
  can't unlock from a daily game. (Mystery achievement "Speedrun" is handled in Phase 4 and
  surfaced via a single post-summary read, not the re-poll loop.)
- Every section renders a **fixed-size placeholder** matching its final layout, so nothing
  shifts when data lands.

### 1.5 Empty tray grows when a tile arrives
**Where:** `apps/web/src/components/Tray.tsx:99`, `styles.css` `.tile-rack` (:1463).

**Cause:** the empty-state `<p class="hint">All tiles placed. Nice.</p>` is ~20px tall; a row
of `.tile-chip` is 46px (58px at the large breakpoint) plus padding; `.tile-rack` has no
`min-height`. The `.pending` incoming chip is `visibility:hidden` but still takes space, so the
jump happens the instant the drawn tile mounts.

**Change:** give `.tile-rack` a `min-height` = one chip row + vertical padding, restated at
every breakpoint where chip size or rack padding changes. Center the empty-state hint
vertically within that height.

**Verify:** measure `.rack-dock` `getBoundingClientRect().height` in three states — empty,
one tile, one full row — at each breakpoint; empty and one-row must match exactly.

### 1.6 No Bunch indicator on daily
**Where:** `apps/web/src/pages/Game.tsx:1695-1703` (`.topbar-bunch-card`).

**Change:** don't render the bunch card when `isDaily`. Let the remaining topbar cards take
the space (no placeholder card).

---

## Phase 2 — Daily Results "Your game" redesign (mockup C)

**Where:** `Results.tsx` daily branch (~:263-424), `styles.css` `.daily-*` rules.

Matches the solo/multiplayer "Your game" pattern: one `.panel.results-earned` containing a
tile grid, with the share box nested inside it.

```
Your game
┌──────────────┬──────────────┐
│   PLATES     │  2:03        │  ← "Personal Best" tag (corner badge) when applicable
│ Longest word │  Time        │
├──────────────┼──────────────┤
│     1        │   64%        │  ← "First!" when nobody else has solved today
│  Day streak  │ Solvers beaten│
└──────────────┴──────────────┘
┌─ Share your result ─────────── [Copy] ┐   ← darker nested container
│ Plantain Pieces · Oct 6               │
│ Solved in 2:03 · beat 64%             │
└───────────────────────────────────────┘
```

- **Removed:** the standalone `.daily-streak-update` "N-day streak!" pill under the header;
  the free-floating "Be the first to solve today!" pill; the loose "New personal best!" line;
  the separate `.daily-share-card` below the board.
- **Personal Best tag:** small `--color-secondary` badge pinned to the Time tile's top-right
  corner, label text exactly **"Personal Best"**. Must not change the tile's size.
- **Solvers beaten tile:** value `X%` from `getDailyResultSummary`; `First!` when the player is
  the first solver. Skeleton while loading.
- **Share box:** nested container one step darker than the tile surface (new token if none
  fits), heading "Share your result", Copy button aligned right, share text in a monospace
  block. Share text content itself unchanged (built at `Results.tsx:236-248`).
- **No achievements section** on daily (see 1.4). "Your board" window stays below, unchanged.
- Header ("Solved!" + date) unchanged.
- 4 tiles in a 2×2 grid at every width; tiles reuse `.stat-tile`.

---

## Phase 3 — Solo peel batches + landing page

### 3.1 Solo peel batches
In solo, a Peel draws **N** tiles instead of 1. Multiplayer and daily are unchanged.

- **Setting:** `SoloSetupModal.tsx` gains a "Tiles per peel" slider, range **1–7**, integer.
  Default follows Bunch-size preset: **Quick 2, Standard 3, Full 5**. Changing the preset
  resets the slider to that preset's default; the player may then move it freely.
- **Storage:** `rooms.mode_config.peel_batch` (int). Worker validates 1–7 on `POST /rooms/solo`;
  `create_solo_room` clamps to 1–7 and defaults to 1 if absent (old rooms keep old behaviour).
- **Server (`peel` RPC):** `create or replace` with the **exact existing signature** (per
  CLAUDE.md — no new overload). For `mode = 'solo'`: draw `least(peel_batch, bunch_count)`
  tiles; the "can peel" gate becomes `bunch_count >= 1`. **Last peel takes the remainder.**
  All other modes fall through unchanged. The `peel` room_event carries the drawn count.
- **Client:** `runAutoAction`'s peel-vs-Plantains gate uses `bunchCount >= 1` for solo instead
  of `bunchCount >= activePlayers.length`. The slice-fly layer animates N slices staggered
  (same path Dump already uses for 3).
- **Stats:** "Tiles peeled" counts tiles drawn, so it naturally reflects batches.
- **Keep in sync:** none in `packages/shared` beyond the default-per-preset table, which lives
  in `tiles.ts` next to `BUNCH_SIZE_PRESETS`.

### 3.2 Landing page
**Where:** `apps/web/src/pages/Home.tsx`, `styles.css`.

- **Profile button embedded in the display-name field:** a smaller version of the current
  Profile button (avatar + the word "Profile") sits inside the right end of the name input.
  The input gets right padding equal to the button's width so long names truncate with an
  ellipsis (`text-overflow: ellipsis`) *before* reaching the button. The separate
  `.home-profile-btn` in `.home-links` is removed; the dictionary button stays there.
- **Create vs. join separation:** a divider between "Create Room" and the code-input + Join
  row — a horizontal rule with centered text "or". Join row unchanged otherwise.
- Must keep the 2026-07-27 mobile fixes: `min-width: 0` on flex inputs, no horizontal overflow
  at 280px.

---

## Phase 4 — Easter eggs + mystery achievements

### 4.1 Egg words
Easter-egg words are **always valid, in every dictionary and every mode**, regardless of the
room's dictionary config or length bounds. They spread by word of mouth; shipping the list in
the public bundle is fine (unlike Xtina mode).

| Word | Effect |
|---|---|
| **MIT** | Valid everywhere. Its tiles tint **maroon** instead of the green valid tint. |
| **SUPERCALIFRAGILISTICEXPIALIDOCIOUS** | Having it on your board, validly placed, **instantly wins the game** (any mode). |
| **GHOST** | Once it has appeared validly on your board, opponents see your tile count as **"??"** for the rest of the game, even if you later break the word. |
| **FREEZE** | **Timed solo only:** the clock stops for 10 seconds, once per game, the first time the word validly appears. No effect in other modes (daily rankings stay fair). |

**Single source of truth:** `packages/shared/src/easterEggs.ts` exports the word list and
per-word metadata. The SQL twin is a `_easter_egg_words()` immutable function. Keep them in
sync (same convention as the tile distribution).

**Validation:** `_find_invalid_words_cfg` treats any egg word as valid before the dictionary
EXISTS checks — added as a separate short-circuit, **not** OR'd into the existing two-EXISTS
shape (that shape is load-bearing for index use; see the 2026-07-28 CLAUDE.md entry). Because
this function backs both live `/validate` and Plantains/summary checks, eggs are accepted
everywhere at once. The client's word-verdict cache marks egg words valid locally without a
request. Supercali's 34 letters are fine: grid word extraction has no length cap; the
`^[A-Z]{2,20}$` pattern applies only to custom-word normalization, which eggs never pass through.

**Per-egg mechanics:**
- **MIT tint:** `GameBoard` adds `board-tile egg-mit` for cells belonging to a validated `MIT`
  word, taking priority over `valid` (same precedence pattern as the Xtina `accent` class).
  New tokens `--color-tile-mit-bg` / `--color-tile-mit-border`, with colorblind-mode overrides
  alongside the existing valid-tint overrides. Also applies in `BoardPreview` (Results/viewer).
- **Supercali win:** client detects the word in its validated grid and calls a new Worker route
  `POST /rooms/:id/supercali`. The Worker re-runs structural validation on the submitted grid
  with a relaxed rule: the grid's letters must be a **sub-multiset** of the rack (not equal —
  other tiles may still be in hand), the grid must be connected with no orphans, all words
  valid, and it must contain the word. Then a new `supercali_win` RPC (row-locked like the
  others) finishes the room with the caller as winner, bypassing the bunch-low gate, and
  appends a `game_over` event flagged `supercali: true`. Results shows a special callout.
- **GHOST:** new `room_players.ghosted boolean default false`. Set via the existing
  `report_progress` path (new optional flag) when the client sees GHOST validated.
  `room_players_public` returns `null` for `tile_count`/`remaining_count` when `ghosted`; the
  client renders null-for-a-ghosted-player as "??". Cleared on `rematch_room` reset.
- **FREEZE:** client-side clock pause in `Game.tsx`'s Timed solo ticker; on trigger the client
  reports it (new `freeze_used` field via `report_progress`), and `archive_game` subtracts
  10 000 ms from that room's solo duration before rolling up best times. Client-reported and
  spoofable — accepted.

**Detection:** a hook (`useEasterEggs`) watches the validated word set for the local grid and
fires each egg's trigger once per game.

### 4.2 Mystery achievements
New achievements flagged `hidden: true` in `packages/shared/src/achievements.ts`. Before
unlocking, they render as a **"???"** tile with a vague hint; after unlocking, the real name.

| id | Hint (shown locked) | Unlocks when |
|---|---|---|
| `egg_hunter` | Some words are more equal than others | any egg word validly on your board |
| `mind_and_hand` | Mind and hand | MIT validly on your board |
| `practically_perfect` | Practically perfect | win via Supercali |
| `collector` | Collector | every egg in `easterEggs.ts` found at least once (4 today; grows with the list) |
| `speedrun` | Speedrun | solve the daily in under 60 seconds |

- **Egg tracking:** `submit_game_summary` accepts an optional `eggs_found: string[]` (validated
  against the egg list server-side). Persisted cumulatively in new
  `profiles.eggs_found text[]` (self-read only under the existing `profiles_select_own` policy;
  not added to `profiles_public`). Client-reported eggs are spoofable — accepted.
- `practically_perfect` unlocks server-side in `supercali_win`; `speedrun` server-side in the
  daily archive from server-measured duration.
- Existing guest lock on the Achievements tab applies unchanged.
- Results' achievement strip shows a newly unlocked mystery achievement by its real name.

---

## Testing / verification

Per the verification-honesty rule: typecheck/build are not proof.

- **1.1, 1.3, 2, 3.2:** browser-verified in the preview (screenshots; `*{transition:none}`
  injected before reading computed styles).
- **1.2:** browser — switch pills rapidly, confirm values update synchronously and no network
  request fires per switch.
- **1.4:** browser — network panel shows parallel requests; no layout shift (compare element
  rects before/after data lands).
- **1.5:** rect measurements as described in 1.5.
- **3.1:** SQL smoke test (local stack) — batch draw counts, remainder on last peel, gate at
  bunch 1, multiplayer peel unchanged; vitest for the preset-default table.
- **4.x:** vitest for `easterEggs.ts`; SQL smoke test for `_find_invalid_words_cfg` egg
  acceptance under a restrictive dictionary config, `supercali_win` sub-multiset rule and
  rejection cases, `room_players_public` masking when ghosted, FREEZE duration adjustment,
  each mystery achievement's unlock path. Browser check of MIT maroon tint.
- Migrations run locally in filename order before handing to prod.

## Build order
1. Phase 1 (1.5, 1.6, 1.1 first — small; then 1.2/1.3, 1.4)
2. Phase 2
3. Phase 3 (3.1, 3.2 independent)
4. Phase 4

## Deferred — paper design phase (separate spec)
Bring the Dictionary journal's burnt-parchment treatment to more surfaces. Candidates the user
liked: the **Profile page**, the **share text**, and possibly the **Results page**. To be
brainstormed on its own.
