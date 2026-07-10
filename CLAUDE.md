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

- **Frontend:** React + Vite + TypeScript, `react-konva` for the 50×50 grid (pan/zoom, box/
  shift-select), Zustand, React Router, `@supabase/supabase-js`. → Cloudflare Pages.
- **Backend:** Cloudflare Worker (Hono). → game-action gateway.
- **DB/Auth/Realtime:** Supabase (Postgres + Auth + Realtime).
- **Dictionary:** ENABLE1 (public domain) in the `words` table. Length + custom-set filtering
  works; `topics[]` filtering is **stubbed** (no public topic-tagged list exists yet).

## Repo layout

```
plantain-pieces/
  apps/
    web/                 # React app (Cloudflare Pages)      — DONE, browser-verified
      src/pages/          #   Home, Lobby, Game, Results
      src/components/GridCanvas.tsx  # react-konva 50x50 pan/zoom grid, click-place/pick-up
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

## Current status (2026-07-10)

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
  Realtime sync across two independent sessions (zero page reloads), Split, Konva grid tile
  placement/pickup, Bunch graphic, opponent tile counts. Peel/Dump/Plantains wiring reuses the
  already-verified Worker endpoints.
- ℹ️ Local analytics is disabled in `config.toml` (Windows would require exposing the Docker
  daemon over TCP for it — not worth it for a side service we don't use).
- ⬜ Not yet built: box/shift-select for multi-tile grid operations (only single-tile click
  place/pick-up exists), spectator mode UI, emoji reactions, rematch (currently a stub that just
  navigates home), friends list, achievements, dictionary settings UI, daily challenge, solo play.

### Windows/Docker gotchas hit during setup (for next time)
- If `npx supabase start` fails with a docker-context pipe error, run
  `docker context use desktop-linux` (the CLI sometimes points at the `default` npipe context,
  which needs admin rights; `desktop-linux` doesn't).
- A stale/corrupted socket file at `%LOCALAPPDATA%\Docker\run\*.sock` can block Docker Desktop
  from starting ("file cannot be accessed by the system"). Fix: close Docker Desktop, delete the
  `Docker\run` folder from an **admin** PowerShell, relaunch.
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
