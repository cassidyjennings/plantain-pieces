# CLAUDE.md — Plantain Pieces

Guidance for Claude Code when working in this repository.

## What this is

**Plantain Pieces** is an online, Bananagrams-style multiplayer word game. Players race to build
their own connected crossword grid from a shared tile Bunch. In-game terminology:

- **Split!** — the start call; everyone flips tiles and begins building.
- **Peel!** — when a player uses all their tiles, *every* player draws 1 new tile from the Bunch.
- **Dump!** — return 1 unusable tile face-down, draw 3 in exchange.
- **Plantains!** — the win call; when the Bunch is too low to Peel, a player completes a valid,
  fully-connected grid using all their tiles.

Bananagrams rules apply: standard 144-tile distribution, all tiles must connect (no orphans),
no rate limiting on Peel/Dump. Grid is a bounded 50×50.

Full product spec (all screens, differentiators, phases) lives in the plan file:
`~/.claude/plans/i-m-building-plantain-pieces-twinkling-fairy.md`.

## Build priority

1. **Multiplayer core** ← current focus (rooms, grid, Split/Peel/Dump/Plantains, realtime sync)
2. Achievements
3. Puzzle of the day
4. Bot opponent (later)

No monetization.

## Architecture (decided — do not silently change)

- **Authoritative game state lives in Supabase Postgres.** Every mutation goes through a
  `SECURITY DEFINER` RPC that takes a **row lock on the room** (`SELECT ... FOR UPDATE`) before
  touching the Bunch, so two simultaneous Peels can never draw the same tile.
- **Cloudflare Worker (Hono) is the write gateway.** It holds the Supabase **service-role** key,
  authenticates each request by calling `supabase.auth.getUser(jwt)`, runs **structural grid
  validation** (via `@plantain/shared`), then calls the RPCs. Clients never call the action RPCs
  directly (they're revoked from `anon`/`authenticated`).
- **Realtime = Postgres Changes on the `room_events` table.** Each RPC appends a public-safe event
  row *inside its transaction*; clients subscribe filtered by `room_id`. This is the fan-out
  mechanism and doubles as a reconnect/replay log.
- **Opponent grids are never sent.** Only tile *counts* + public status are exposed, via the
  `room_players_public` view. A player's `rack`/`grid_state` are RLS-private and pulled on demand
  via the `get_my_state` RPC.
- **Guests use Supabase anonymous auth** (`signInAnonymously()`), not a separate sessions table.
  A `profiles` row is auto-created per `auth.users` row by a trigger. OAuth upgrade later links an
  identity to the *same* id so progress carries over.

### Server-side state model (important subtlety)
`room_players.rack` holds a player's **full tile inventory** (every letter they own, whether or
not it's placed on their grid). The server does NOT track placement in real time. The client
tracks placement locally and submits its full `grid_state` with a Peel/Plantains action; the
server validates that the grid's letter multiset exactly equals the player's `rack`. `tile_count`
= `jsonb_array_length(rack)` and is the only publicly visible per-player number.

## Tech stack

- **Frontend:** React + Vite + TypeScript, Zustand, React Router, `@supabase/supabase-js`. →
  Cloudflare Pages. The 50×50 board is a **DOM-based pan/zoom surface** (`GameBoard.tsx`) with a
  custom unified pointer-drag system (tray↔board, board reposition, tray reorder) — react-konva
  was removed (cross-canvas/DOM dragging into the HTML tray was intractable; the design handoff is
  also HTML-native).
- **Backend:** Cloudflare Worker (Hono). → game-action gateway.
- **DB/Auth/Realtime:** Supabase (Postgres + Auth + Realtime).
- **Dictionary:** ENABLE1 (public domain) in the `words` table. Length + custom-set filtering
  works; `topics[]` filtering is **stubbed** (no public topic-tagged list exists yet).

## Repo layout

```
plantain-pieces/
  apps/
    web/                 # React app (Cloudflare Pages)      — DONE, browser-verified
      src/pages/          #   Home, Lobby, Game (owns the drag orchestration), Results
      src/components/GameBoard.tsx   # DOM 50x50 pan/zoom board (tiles = divs, CSS grid bg)
      src/components/Tray.tsx        # tile rack + collapse-duplicates toggle
      src/components/DragGhost.tsx   # floating tile that follows the pointer during a drag
      src/lib/board.ts     #   CELL size + world extent for board coordinate math
      src/hooks/useRoomEvents.ts     # Realtime subscription to room_events
      src/lib/api.ts       #   typed client for the Worker (attaches Bearer token)
      src/lib/rooms.ts     #   direct RLS-gated reads of rooms_public/room_players_public
      .env.local           #   VITE_SUPABASE_URL/ANON_KEY/API_URL (gitignored)
    api/                 # Cloudflare Worker gateway (Hono)   — DONE, verified over real HTTP
      src/index.ts       #   routes: room lifecycle + peel/dump/plantains
      src/auth.ts        #   requireAuth middleware (supabase.auth.getUser(jwt))
      src/gridValidation.ts  # fetchRack() — direct service-role read of a player's rack
      wrangler.toml       #   SUPABASE_URL in [vars]; keys in .dev.vars (gitignored)
  packages/
    shared/              # pure TS game logic — DONE, tested
      src/tiles.ts       #   144-tile distribution, deal counts, GRID_SIZE, MAX_PLAYERS
      src/bunch.ts       #   unbiased draw / return-tile reference impl (mirrors the SQL RPC)
      src/grid.ts        #   connectivity, extractWords, orphans, validateStructure/WithDictionary
      src/types.ts       #   shared domain types + DEFAULT_DICTIONARY_CONFIG
  supabase/
    migrations/
      *_schema.sql       # tables, views, RLS, realtime — DONE, applied + smoke-tested locally
      *_rpcs.sql         # SECURITY DEFINER game RPCs        — DONE, applied + smoke-tested locally
    seed/enable1.txt     # vendored ENABLE1 word list (172,823 words)
    config.toml          # local stack config (anonymous sign-ins enabled, analytics disabled)
  scripts/
    seed-dictionary.mjs  # loads enable1.txt into public.words — DONE, idempotent
```

**Uses npm workspaces, NOT pnpm** (Corepack couldn't write into `Program Files` without admin on
this machine). Keep using `npm`.

## Key files & functions to reuse (don't reinvent)

- `packages/shared/src/grid.ts`: `validateStructure(grid, dealtTiles)` and
  `validateWithDictionary(grid, dealtTiles, isValidWord)` — the single source of truth for grid
  validity, used by BOTH the client (instant feedback) and the Worker (authoritative check).
- `packages/shared/src/tiles.ts`: `TILE_DISTRIBUTION`, `initialDealCount(n)` (2–4→21, 5–6→15,
  7–8→11), `GRID_SIZE = 50`, `MAX_PLAYERS = 8`.
- SQL RPCs (`supabase/migrations/*_rpcs.sql`): `create_room`, `join_room`, `set_ready`,
  `start_game` (Split), `peel`, `dump`, `finish_game` (Plantains), `find_invalid_words`,
  `get_my_state`, `persist_grid`, `append_room_event`. The Worker calls these; don't duplicate
  their logic in JS.
- The 144-tile distribution is defined in BOTH `tiles.ts` and `_fresh_bunch()` in SQL — keep them
  in sync if ever changed.

## Commands

```bash
npm install                 # install all workspaces
npm run test:shared         # vitest for packages/shared (22 tests, all passing)
npm run build:shared        # tsc build of shared

npm run db:start            # npx supabase start   (needs Docker Desktop running)
npm run db:reset            # npx supabase db reset (re-applies migrations + seed)
npm run db:stop
npm run db:seed             # load ENABLE1 into words (idempotent; --reset to wipe base words first)

npm run dev:api             # wrangler dev  (Worker; needs apps/api/.dev.vars — see below)
npm run dev:web             # vite dev      (React; needs apps/web/.env.local — see below)
```

`apps/api/.dev.vars` (gitignored) needs `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.
`apps/web/.env.local` (gitignored) needs `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
`VITE_API_URL` (the Worker's local URL, e.g. `http://127.0.0.1:8787`).
Get Supabase keys from `npx supabase status -o json` after `npm run db:start`.

## Deployment

Three managed platforms, each auto-deploying from this GitHub repo on push to `main` (no
server process to run or patch anywhere):

- **`apps/web`** → **Vercel**. Root-level `vercel.json` gives it an explicit
  `buildCommand`/`outputDirectory`/`installCommand` so it doesn't rely on Vercel's monorepo
  auto-detection. Env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL`) are
  set in the Vercel project's dashboard, not committed. Every push to `main` redeploys
  automatically — native Vercel behavior, nothing in this repo triggers it.
- **`apps/api`** → **Cloudflare Workers**, via `.github/workflows/deploy-worker.yml` (runs on
  push to `main` touching `apps/api/**` or `packages/shared/**`; auth'd with
  `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repo secrets). `wrangler.toml`'s default
  `[vars]` block stays pointed at `127.0.0.1` for local `wrangler dev`; the deployed
  `[env.production.vars]` block holds the real Supabase URL. `SUPABASE_ANON_KEY` /
  `SUPABASE_SERVICE_ROLE_KEY` for that env are Worker secrets (`wrangler secret put <name>
  --env production`), set once and untouched by future deploys.
- **`supabase/`** → **Supabase Cloud** (free tier — auto-pauses after 7 days with zero API
  traffic; a one-click "Restore" in the dashboard, not a re-deploy). **Not** auto-applied on
  push: a new migration is deliberately a manual step (`supabase db push`, or ask Claude to
  run the new file's SQL directly against the prod connection string) — auto-running
  arbitrary schema SQL against production on every push is a foot-gun, not a convenience.

## Current status (2026-07-21)

- ✅ Monorepo scaffold, `packages/shared` complete and tested.
- ✅ Supabase schema, RLS, views, realtime, and all game RPCs **written, applied, and
  functionally smoke-tested** against a local `supabase start` stack: create_room → join_room →
  start_game (Split deals correctly) → peel (atomic per-player draw + stale-peel guard verified)
  → dump → find_invalid_words → get_my_state → finish_game (Plantains, bunch-low gate verified)
  all pass, and `room_events` payloads are confirmed public-safe.
- ✅ ENABLE1 dictionary seed loader (`scripts/seed-dictionary.mjs`, word list vendored at
  `supabase/seed/enable1.txt`, 172,823 words). Idempotent, run via `npm run db:seed`.
  `find_invalid_words` verified against real seeded words.
- ✅ Worker gateway (`apps/api`, Hono) — auth middleware, all room lifecycle + in-game routes,
  structural validation before Peel/Plantains reach the RPC layer. Verified end-to-end over real
  HTTP with genuine anonymous auth sessions (see git log for the full test list).
- ✅ **Multiplayer core is fully built and browser-verified end-to-end.** React app (`apps/web`)
  built and tested live in a browser: guest auth, room create/join, Lobby ready-up with live
  Realtime sync across two independent sessions (zero page reloads), Split, Bunch graphic,
  opponent tile counts. Peel/Dump/Plantains wiring reuses the already-verified Worker endpoints.
- ✅ **Full UI redesign applied** from a design handoff (jungle theme, Grandstander/Nunito fonts,
  design tokens in `src/styles/tokens.css`, a plantain-bunch Bunch meter that shrinks with the
  Bunch (later reworked — see the slice-fly bullet below),
  animated PEEL!/DUMP!/PLANTAINS! call-outs). All four screens restyled + browser-verified.
- ✅ **Gameplay interaction overhaul (2026-07-10), browser-tested:**
  - Board moved off react-konva to a **DOM board** with a custom unified pointer-drag system:
    drag tray→board, reposition board tiles, reorder within the tray; snap to nearest cell on
    release; a ~5px threshold distinguishes click from drag; empty-space drag pans, wheel zooms.
  - **Peel and Plantains are auto-detected** (no buttons): when the local grid becomes
    structurally valid (all tiles placed, connected, no orphans) the client auto-fires Peel if the
    Bunch can still peel, else Plantains. A grid-signature guard prevents re-firing a rejected
    ("rotten") Plantains until the grid changes. Dump is still a manual action on a selected tile.
  - **Live word validation**: debounced `POST /rooms/:id/validate` (→ `find_invalid_words`) tints
    board tiles green when they belong to a valid dictionary word.
  - **Collapse-duplicates tray toggle**: groups duplicate letters into one tile with a count badge
    that decrements as tiles are placed.
- ✅ **Bunch slice-fly animation (2026-07-12), browser-verified:** the old vertical peel-mascot +
  progress bar were replaced by a **stretched side-plantain** (`BunchPlantain.tsx`) in a rounded
  groove that shrinks (fill clipped from the right = a "cut face") as the Bunch empties, with a
  live count. Each *drawn* tile (Peel → 1, Dump → 3 staggered) flies a plantain "slice" from the
  cut end: it rolls right off-screen, re-enters from the right at tray height, and rolls left into
  the tile's real slot. Built in `SliceFlyLayer.tsx` — a fixed `pointer-events:none` overlay that
  animates slices imperatively via the **Web Animations API** (transform/opacity only), measuring
  target chip rects FLIP-style at leg-B start; the destination chip renders `.pending`
  (visibility:hidden, keeps layout) until its slice lands, then pops in. Trigger reuses the
  existing `justDrawn` flag (`Game.tsx` effect), so board/recall moves don't animate. Respects
  `prefers-reduced-motion` (skips flight, reveals immediately) and caps concurrent flights.
  `PlantainMascot.tsx` was removed (fully superseded).
- ✅ **Custom Dictionaries feature (2026-07-15), browser-verified end-to-end.** Players build named
  custom word lists, toggle word sources (base ENABLE1 + their own sets) and length bounds per game,
  and save named **presets** (dictionary + settings combos) to reuse. The room host sets the active
  config pre-Split; it broadcasts live to the lobby via a `dictionary_config_changed` `room_event`.
  - **DB** (`supabase/migrations/20260715000001..3`): new `dictionary_presets` table; split the old
    world-readable `words_select_all` RLS into `words_select_base` (base rows only) +
    `words_select_own_custom` (owner-scoped) — a real privacy fix so users can't read each other's
    custom words; `custom_word_sets_with_count` view for cheap listing. New `SECURITY DEFINER` RPCs
    (`_validate_dictionary_config`, `create/update/delete_custom_word_set`,
    `save/delete_dictionary_preset`, `set_dictionary_config`), locked to `service_role` in their own
    do-block. `find_invalid_words`/`create_room` needed **zero** changes.
  - **Shared** (`packages/shared/src/dictionary.ts` + tests): word normalization (`^[A-Z]{2,20}$`,
    dedupe), caps (2000 words/set, 30 sets, 25 presets), `validateDictionaryConfig()` — reused by
    client (instant feedback) and Worker (defense-in-depth 400s); RPC re-validates authoritatively.
  - **Worker** (`apps/api/src/dictionaries.ts` + routes): CRUD for sets/presets, `PATCH
    /rooms/:id/dictionary`, and `GET /rooms/:id/dictionary/set-names` (service-role name resolution
    so non-hosts see set *names*, not raw UUIDs, without widening RLS). Reads of a user's own
    sets/presets go **direct via RLS** from the client (`apps/web/src/lib/dictionaries.ts`), not the
    Worker.
  - **UI** (`DictionaryJournal.tsx` + `WordSetEditor.tsx`): an in-world **burnt/crinkled tan book
    page** — layered parchment gradients + SVG turbulence grain + scorched vignette, torn deckle
    edge via an **SVG displacement `mask`** (not a clip-path), parchment index tabs that tuck under
    the page edge, and a **top-down page-flip** (`rotateX`, header title included) on tab change.
    Tabs: Dictionaries (base list folded in at top + your sets below), Word Length, Presets. Opens
    from **Home** ("My Dictionaries", standalone) and the **Lobby** (host edits + Apply; non-hosts
    see a read-only live view). Lobby shows a settings summary chip that pulses on live changes; the
    in-game top bar shows three pills (min length · base list · custom dictionaries). All motion
    respects `prefers-reduced-motion`.
- ✅ **Leave room / leave game + host migration (2026-07-15):** `leave_room` RPC
  (`20260715000004`) — returns a leaver's tiles to the Bunch mid-game, hands host to the next
  player by join order (seat) when the host leaves, deletes the room when the last player exits,
  and appends a `player_left` event. Wired to a "Leave Room" button (Lobby) and "Leave" (Game, with
  confirm). RPC logic done + migrated; the live two-session host-handoff walkthrough is the one
  remaining browser check.
- ✅ **Solo play is a real feature now** (2026-07-20): Split allows a single player. `start_game`
  requires `>= 1` (migration `20260720000002`) and `Lobby.tsx` matches — the old TEMP runtime-patch
  hack is retired and no longer needs reverting.
- ✅ **Account / Profile system (2026-07-20), browser-verified end-to-end.** A single `/profile`
  route with in-page tabs (Overview/Stats/Achievements/History/Settings). Plan at
  `~/.claude/plans/implement-the-account-profile-system-velvet-pumpkin.md`.
  - **Identity:** display name is now persisted to `profiles.display_name` (was localStorage-only) —
    validated by shared `validateDisplayName` (1–20 chars, non-unique). A customizable plantain SVG
    **`Avatar.tsx`** (config in `profiles.avatar_config`, options in shared `avatar.ts`), snapshotted
    into `room_players.avatar_config` by a trigger (migration `…05`) so it shows in the lobby grid.
    Sign-out + config-gated Google `linkIdentity` guest-upgrade (`lib/auth.ts`;
    `enable_manual_linking=true` + `[auth.external.google]` in `config.toml`; Apple is
    deliberately not offered — it requires a paid Apple Developer account).
    Data export (client JSON download) + account deletion (`prepare_account_deletion` clears the
    ephemeral-room FKs, then `auth.admin.deleteUser` cascades everything).
  - **Durable history + stats (server-authoritative):** new `games` / `game_players` / `profile_stats`
    tables (migrations `…01`/`…02`). The Worker calls `archive_game` right after `finish_game`
    (Phase 1: snapshots the roster, counts peels/dumps + first-peel timing from `room_events`, rolls
    up `profile_stats`, unlocks server-side achievements). `finish_game` **no longer emits
    `game_over`** (migration `…06`) — the **Worker** emits it post-archival so it can carry the
    `gameId`; every client submits its own loosely-validated end-of-game summary (words/move-stats,
    shared `stats.ts` `validateGameSummary`) to `POST /games/:id/summary` → `submit_game_summary`
    (Phase 2, idempotent via `summary_applied`). `useMoveTracker.ts` builds the client summary.
  - **9 achievements** wired (defs in shared `achievements.ts`); **accessibility** (colorblind /
    font-size / contrast) via `<html>` data-attributes + a localStorage `settingsStore`, with the
    valid-word tile tint tokenized so colorblind modes retint it.
  - **Deliberate scoping calls** (see plan): word rarity is a **letter-scarcity proxy** (no frequency
    corpus exists); "streak" is a **general daily-play streak** (daily challenges don't exist yet);
    best-bunch-time, Daily Devotee, daily-streak milestones, Rematch Rival, and Sold Out Show were
    **cut** ("only what's computable now") — they unblock when solo/daily/rematch/spectator land.
- ✅ **OAuth enabled + follow-up fixes (2026-07-20):** Google is `enabled = true` in `config.toml`,
  credentials read from `env()` → a gitignored root `.env` (template `.env.example`, step-by-step
  in `docs/OAUTH_SETUP.md`). Verified: the stack boots with placeholder creds, `.env` substitution
  flows into the OAuth `client_id`, and `linkIdentity` returns a real accounts.google.com authorize
  URL (redirect allow-list widened with `/**`). Real sign-in just needs the user's own Google
  credentials pasted into `.env`. **Apple Sign In is deliberately not offered** (needs a paid Apple
  Developer account) — `[auth.external.apple]` is disabled, and there's no Apple button in the UI.
  Also: display names now allow special characters/emoji (only control chars rejected —
  `validateDisplayName` + `update_profile` migration `20260720000001`); **solo play** is a real
  feature again (`start_game` allows 1 player, migration `20260720000002`; `Lobby.tsx` matches) so
  the old TEMP hack note is retired; the Home link says "My Profile"; and selected profile
  tabs/segmented/avatar options hover to the accent-hover orange.
- ✅ **Solo mode (2026-07-21), browser-verified end-to-end.** A single player clears a Bunch alone.
  Plan at `~/.claude/plans/implement-solo-mode-plantain-pieces.md`. Key finding that shaped the
  design: the multiplayer engine was already player-count-agnostic and bunch-content-agnostic
  (`runAutoAction`'s `bunchCount >= activePlayers.length` gate, the RPCs' "every player draws 1"
  loops) — solo reuses the exact same board/peel/dump/Plantains code, not a fork.
  - **Setup**: `SoloSetupModal.tsx` (dictionary via the existing `WordlistEditor`, Bunch-size
    presets Quick/Standard/Full, Zen/Timed toggle) → `POST /rooms/solo` → **new dedicated
    `create_solo_room` RPC** (not an overloaded `create_room` — appending params to an existing
    RPC risks a second Postgres overload and an ambiguous "function is not unique" error on named-
    parameter `.rpc()` calls; a dedicated function also matches this repo's one-RPC-per-action
    convention). It creates the room, seeds a scaled Bunch, deals the fixed 21-tile hand, and
    marks it `active` — all atomically, so the client skips the Lobby and lands straight in
    `/game`.
  - **Bunch scaling**: `scaledBunchDistribution()` (`packages/shared/src/tiles.ts`) + SQL twin
    `_scaled_bunch` — largest-remainder proportional scaling of the 144-tile distribution, with a
    min-1-per-letter guarantee once the bunch fits the alphabet (≥26). **Both implementations use
    pure integer arithmetic (a remainder numerator over the common denominator 144), not a
    float/`numeric` ratio** — a first version used `bunchSize/144` as a ratio and broke: Postgres
    `numeric` division and JS IEEE-754 doubles round a non-terminating fraction like 96/144=2/3 to
    different decimal tails, so "tied" remainders sorted in a different order in SQL vs TS. Worth
    remembering for any future cross-runtime largest-remainder/apportionment logic in this repo.
  - **Mode-aware stats**: `rooms`/`games`/`game_players` gained `mode`/`mode_config` columns;
    `profile_stats` was **re-keyed from `profile_id` alone to composite `(profile_id, mode)`** so
    solo and multiplayer lifetime stats don't blend. The daily play **streak is deliberately
    account-wide, not per-mode** (user's explicit call) — it moved off `profile_stats` onto
    `profiles` itself. `archive_game`/`submit_game_summary` updated in place (same signatures, no
    overload risk) to key by mode; `century_club`/`peel_machine` (lifetime, mode-agnostic
    milestones) now check the **sum across a profile's mode rows**, not a single mode's row.
  - **Client**: `Game.tsx` gained a live elapsed-time ticker for Timed solo (gated on
    `room.mode_config.timed`, itself free-standing — `duration_ms` is stored for every game
    regardless of the toggle, only the *live display* is gated). `Results.tsx` branches solo
    copy + an elapsed-time tile for Timed. The Stats tab's `fetchMyStats()` **had to change**
    (not just "nice to have") since multiple `profile_stats` rows per profile now exist — it takes
    an optional mode and client-aggregates across modes when omitted (the "All" pill).
  - **Locked-in decisions** (asked via 4 clarifying questions): Dump is byte-identical to
    multiplayer in solo (a genuine reroll, not a guaranteed escape — matches physical solo
    Bananagrams); the initial deal stays fixed at 21 regardless of Bunch size; streak is
    account-wide.
- ➡️ **Next up: puzzle of the day, then bot opponent** (per build priority).
- ℹ️ Local analytics is disabled in `config.toml` (Windows would require exposing the Docker
  daemon over TCP for it — not worth it for a side service we don't use).
- ⬜ Not yet built: puzzle of the day (next), bot opponent, box/shift-select for multi-tile grid
  operations (drag moves one tile at a time), spectator mode UI, emoji reactions, rematch (currently
  a stub that just navigates home), friends list, daily challenge, solo play. (Accounts/profile +
  achievements now DONE — see the 2026-07-20 entry above.)

### Windows/Docker gotchas hit during setup (for next time)
- If `npx supabase start` fails with a docker-context pipe error, run
  `docker context use desktop-linux` (the CLI sometimes points at the `default` npipe context,
  which needs admin rights; `desktop-linux` doesn't).
- **Docker Desktop's stale-socket startup crash is handled automatically — use `npm run db:start`**
  (or `npm run docker:up`), which runs `scripts/docker-up.ps1` first. Don't hand-fix it, and don't
  reboot for it.
  - Symptom: Docker dies on launch with `listening on unix://.../dockerInference: remove ...:
    The file cannot be accessed by the system.` It recreates the bad file each attempt, so it
    loops forever. **It also masquerades as auth bugs**: with Supabase down, the Worker's
    `requireAuth` can't reach Supabase Auth to verify tokens, so every route 401s and the UI shows
    UNAUTHORIZED everywhere. Check Docker before debugging auth.
  - Cause: Docker's services listen on AF_UNIX sockets, which Windows implements as **reparse
    points** under `%LOCALAPPDATA%`. An unclean exit orphans them; Windows then can't open them,
    so Docker's own `remove` fails. Affects at least `Docker\run\` and `docker-secrets-engine\`.
  - Fix: the orphaned *files* can't be deleted unprivileged, but **renaming their parent
    directory** never opens the children and works fine — Docker then recreates a clean folder.
    That's what the script does (quarantine to `<name>.broken-<stamp>`, and sweep old ones, which
    only become deletable after a reboot has released the handles).
- `docker cp` / `docker exec ... /tmp/...` from Git Bash mangles the unix-style destination path
  into a Windows path. Prefix the command with `MSYS_NO_PATHCONV=1` to stop that.
- **Newer Supabase CLI versions do NOT implicitly grant `service_role` table/function access**
  (see `config.toml`'s `auto_expose_new_tables` comment — the old "legacy" auto-grant behavior is
  gone). If a service-role Supabase client gets a `permission denied for table X` error (or it
  gets swallowed and surfaces as some other error upstream), check for a missing explicit
  `GRANT ... TO service_role` — see `supabase/migrations/20260706000003_service_role_grants.sql`.
- **The same is true for `authenticated`/`anon` — an RLS policy alone is NOT enough, you also
  need the base `GRANT SELECT ... TO authenticated`** (see
  `supabase/migrations/20260710000001_authenticated_grants.sql`). This one is nastier than the
  service_role version because of *where* it breaks: **filtered** Postgres Changes realtime
  subscriptions (e.g. `.on('postgres_changes', {..., filter: 'room_id=eq.X'})`) silently fail to
  register when the grant is missing — the client-side `.subscribe()` callback still reports
  `status: 'SUBSCRIBED'` with no error, but nothing ever shows up in `realtime.subscription` and
  no events are ever delivered. **Unfiltered** subscriptions on the same table register fine,
  which is what makes this so easy to miss. If realtime events aren't arriving, check
  `select * from realtime.subscription;` in the DB (should have a row per active filtered
  subscription) before suspecting anything else, and check
  `select has_table_privilege('authenticated', 'public.<table>', 'SELECT');`.

## Conventions & gotchas

- **Shell is PowerShell / Git Bash on Windows.** Line endings: the repo has CRLF warnings; that's
  fine. Prefer absolute paths.
- **No client writes to game tables** — there are intentionally no INSERT/UPDATE RLS policies for
  `authenticated`. All writes flow through the Worker + service role. If you need a new mutation,
  add an RPC and call it from the Worker; do not open a table to client writes.
- **`bunch` (jsonb letter→count) is never exposed to clients** (would enable card-counting).
  Clients read room meta via the `rooms_public` view, which omits `bunch`.
- **`is_room_member(room_id)` must stay executable by `authenticated`** — RLS policies and the
  public views depend on it. Only the *action* RPCs are revoked from clients.
- Peel has an optimistic-concurrency guard (`p_expected_count`) to block double-peel races; the
  Worker passes the rack length it validated against.
- When adding features, respect the build-priority order above; multiplayer core comes first.
- End git commit messages with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` line.
```
