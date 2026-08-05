# Xtina Mode — Design

**Date:** 2026-08-05
**Branch:** `xtina-mode`
**Status:** Approved design, not yet implemented

## What this is

A hidden, account-gated game mode. To the partner account it looks like an ordinary two-player
multiplayer game; in reality the Bunch is scripted so that she is dealt, one word at a time, exactly
the tiles needed to build a fixed 10-word crossword, while the owner account is dealt nothing but
`X` and `Z` and can never form a word. Dotted outlines on the board show where the next word goes.
The three words `YOURE`, `MY` and `LOVE` render in an accent color; `YOURE` is dealt first, `MY`
second-to-last, `LOVE` last.

Two independently useful pieces:

1. **The Stina avatar** — a new avatar option only offered to the partner account.
2. **The scripted game mode** — everything else in this document.

## Gating

| Concept | Mechanism |
|---|---|
| Who may toggle the mode | `profiles.xtina_role = 'owner'` |
| Who the script targets | `profiles.xtina_role = 'partner'` |
| Is the mode armed | `profiles.xtina_enabled` on the owner row |

Both roles are assigned by hand in the Supabase SQL editor against real profile UUIDs. **No account
identity is committed to this repository**, and there is no UI that lists or selects users.

Neither role is a guest: anonymous accounts get a fresh `auth.users` row per session, so a role set
on one would evaporate. Both accounts must be OAuth-linked before roles are assigned.

## The board

Origin: `YOURE`'s `Y` sits at cell **(18, 22)**. The finished figure spans columns 18–32 and rows
19–33 — 15×15 on the 50×50 board, comfortably centered.

### Word placements

| Step | Word | Anchor | Dir | Hooks onto | New tiles dealt |
|---|---|---|---|---|---|
| 1 | YOURE | (18,22) | H | — (opening deal) | 5 · `Y O U R E` |
| 2 | BEAUTIFUL | (20,19) | V | YOURE `U` @(20,22) | 8 · `B E A T I F U L` |
| 3 | INTELLIGENT | (20,24) | H | BEAUTIFUL `I` @(20,24) | 10 · `N T E L L I G E N T` |
| 4 | CARING | (29,20) | V | INTELLIGENT `N` @(29,24) | 5 · `C A R I G` |
| 5 | STRONG | (27,22) | H | CARING `R` @(29,22) | 5 · `S T O N G` |
| 6 | HILARIOUS | (25,22) | V | INTELLIGENT `L` @(25,24) | 8 · `H I A R I O U S` |
| 7 | SPECIAL | (25,30) | H | HILARIOUS `S` @(25,30) | 6 · `P E C I A L` |
| 8 | DRIVEN | (29,28) | V | SPECIAL `I` @(29,30) | 5 · `D R V E N` |
| 9 | **MY** | (18,21) | V | YOURE `Y` @(18,22) | 1 · `M` |
| 10 | **LOVE** | (20,27) | H | BEAUTIFUL `L` @(20,27) | 3 · `O V E` |

**56 occupied cells.** Accent words (bold above): `YOURE`, `MY`, `LOVE`.

### Ordering constraints, satisfied

- `YOURE` first, `MY` second-to-last, `LOVE` last — as requested.
- Every step hooks onto a cell already on the board, so the grid is **connected** at every step.
- Every tile at every step has at least one orthogonal neighbour, so `findOrphans` returns empty at
  every step (`packages/shared/src/grid.ts:120`).
- The finished grid extracts to **exactly** the 10 intended words — every maximal horizontal and
  vertical run of length ≥ 2 was enumerated and checked. There are no accidental cross-words.

The one non-word is `YOURE` (not in Collins/SOWPODS). See "Dictionary" below.

## Bunch arithmetic

This is load-bearing, not a tunable. `peel` requires `bunch_count >= active_players` and
`finish_game` requires `bunch_count < active_players` (`supabase/migrations/20260706000002_rpcs.sql:285`).
The Bunch must therefore be sized so it hits 0 exactly as `LOVE`'s tiles are dealt.

| | Partner | Owner |
|---|---|---|
| Split | 5 | 5 (`X Z X Z X`) |
| 9 peels | 8+10+5+5+8+6+5+1+3 = 51 | 1 each = 9 (`Z X Z X Z X Z X Z`) |
| **Total** | **56** | **14** |

**Scripted Bunch = 70 tiles.** Reads 60 after Split; each peel drains `word tiles + 1`; after
peel #9 it is 0, so `runAutoAction` (`apps/web/src/pages/Game.tsx:965`) computes
`canPeel === false` and fires Plantains with no special-casing.

Both players are dealt 5 at Split so the public tile-count pills stay symmetric — no asymmetry tell
in the opening.

### Bunch composition

```
A:4  B:1  C:2  D:1  E:7  F:1  G:3  H:1  I:6  L:4  M:1
N:4  O:4  P:1  R:4  S:2  T:4  U:3  V:2  Y:1   (partner, 56)
X:7  Z:7                                       (owner, 14)
```

Owner's `X`/`Z` split is exact: 3 `X` + 2 `Z` at Split leaves 4 `X` + 5 `Z` for the 9 peels.

## Architecture

Server-authoritative for anything that must survive a reload. Hints, accent colors and the
placement gate are pure presentation and live entirely in the client. This follows the existing
split: the engine owns tiles, the client owns the board surface.

### Migration `20260805000001_xtina_mode.sql`

- `profiles.xtina_role text` — `check (xtina_role in ('owner','partner'))`, nullable.
- `profiles.xtina_enabled boolean not null default false`.
- `rooms.mode` check constraint gains `'xtina'`.
- `_xtina_bunch()` — returns the 70-tile jsonb above.
- `_xtina_deal(p_room_id uuid, p_step int)` — returns the step's letter array and removes exactly
  those letters from `rooms.bunch`, decrementing `bunch_count`. **Deterministic**: it removes named
  letters rather than calling `_draw_from_bunch`, which draws at random.
- `set_xtina_enabled(p_profile uuid, p_on boolean)` — guarded on `xtina_role = 'owner'`, raises
  `NOT_XTINA_OWNER` otherwise. Revoked from `anon`/`authenticated`, granted to `service_role`, same
  do-block pattern as every other action RPC.
- `start_game` — `create or replace` with an **identical signature** (`uuid, uuid`), so no second
  overload is registered and no `.rpc()` call becomes ambiguous. Inside the existing
  `select ... for update` room lock, a branch fires when all of:
  - host has `xtina_role = 'owner'` and `xtina_enabled = true`
  - exactly 2 non-spectator players
  - the other player has `xtina_role = 'partner'`

  …in which case it seeds the scripted Bunch, deals `YOURE` to the partner and `XZXZX` to the
  owner, and stamps `mode = 'xtina'`, `mode_config = {partnerId, step: 1}`. Otherwise it falls
  through to the existing random deal, unchanged.
- `peel` — same-signature `create or replace`, branch on `mode = 'xtina'`: partner receives
  `_xtina_deal(step + 1)`, owner receives one `X`/`Z`, `mode_config.step` increments. The existing
  `p_expected_count` stale-peel guard is untouched.
- `archive_game` — early-returns on `mode = 'xtina'`. This must not touch her lifetime stats, her
  play streak, or unlock achievements.

### Worker (`apps/api/src/index.ts`)

- `POST /rooms/:roomId/plantains` — **skip the `find_invalid_words` call** when `mode = 'xtina'`
  (currently line 284). `validateStructure` still runs. This is what lets `YOURE` through, and it
  replaces an earlier idea of adding `YOURE` to a dictionary: official word sets are world-readable
  via `official_word_sets` (`20260727000003`), so such a set would have appeared in her Dictionary
  journal as a fake language.
- `POST /rooms/:roomId/dump` — reject with `XTINA_NO_DUMP` when `mode = 'xtina'`. Dump draws from
  the shared Bunch and would desynchronize the scripted deal.
- Skip the end-of-game summary POST for xtina rooms.
- `POST /profile/xtina` → `set_xtina_enabled`, behind the existing `requireAuth` middleware.

### Shared (`packages/shared/src/xtina.ts`)

The board specification: the 10 words with anchors and orientations, the derived per-step cell sets
and letter arrays, and the accent-word list. Consumed by the client for hint rendering, the
placement gate, and coloring.

Its per-step letter arrays are the twin of the SQL literals in `_xtina_deal`. This repo already has
this keep-both-in-sync contract for `TILE_DISTRIBUTION`/`_fresh_bunch()` and
`scaledBunchDistribution`/`_scaled_bunch` — the convention is followed rather than invented here.

**Tests:**
- vitest over the TS spec: every step connected, zero orphans, cumulative letter tallies match the
  Bunch, final grid extracts to exactly the 10 words and no others.
- a scripted `pg` smoke test asserting the racks `_xtina_deal` actually produces match the TS
  arrays step by step, and that `bunch_count` lands on 0 — run locally before any of this reaches
  prod, per the project's existing practice.

### Client

**`GameBoard.tsx`** gains two presentational props:
- `hintCells: Set<string>` — dotted outlines. **Empty outlines, no letters.** She works out the
  word from the tiles in her tray; that is the intended puzzle.
- `accentCells: Map<string, string>` — accent styling for `YOURE`, `MY`, `LOVE`. Accent takes
  precedence over the green valid-word tint, which is also why `YOURE` never visibly reads as an
  invalid word despite failing the dictionary.

**`Game.tsx`**, when `room.mode === 'xtina'` and the local profile is `mode_config.partnerId`:
- Derives hint cells from the shared spec for **`step`** — the word whose tiles are in her tray
  right now — minus any of its cells already occupied by an earlier word's shared letter. At Split
  `step = 1`, so the very first hint is `YOURE`'s five cells.
- Gates `runAutoAction` on `gridMatchesTarget(step)` — the placed grid must equal the cumulative
  target for steps 1..`step` exactly. Placed elsewhere it simply does not advance: no error toast, no rejected drag,
  no visible fight. The board behaves like a normal board.
- Endgame: fire the `PLANTAINS!` callout, **suppress** the auto-navigate to Results, hold the
  finished board on screen, and show a button routing to `/room/:roomId/boards` — the existing
  BoardViewer, already gated on `status = 'finished'` and fed by `room_boards_public`. No message
  text on the board.

The owner's client renders no hints and no accents.

**Dump** is hidden from the tray toolbar in xtina mode for both players.

### Avatar

`ACCESSORY_SETS.base` (`packages/shared/src/avatar.ts:18`) gains `'stina'`. `Avatar.tsx` gets a
branch rendering a **placeholder SVG to be replaced with the real design**. Validation is
data-driven off `ACCESSORY_SETS`, so `validateAvatarConfig` and `normalizeAvatarConfig` pick it up
with no change.

The swatch appears in the avatar editor only when the viewer's own `profiles.xtina_role =
'partner'` — gated on the role alone, deliberately **not** on `xtina_enabled`, so the avatar is not
hostage to whether a game happens to be armed.

## Entry flow

No new screens. The owner toggles the mode on in their profile, creates a room normally, and shares
the code. She joins normally. The lobby is unchanged. The owner presses Split, and `start_game`
routes to the scripted path.

## Known seams

- **`bunch_count` is public** and drives the BunchPlantain meter — it will read 60 after Split
  instead of 134. Solo mode already ships variable Bunch sizes so this is not structurally strange,
  but it is the one visible difference from a default game. Fixable later by publishing a scaled
  count if it matters.
- **`rooms_public` exposes `mode` and `mode_config`** to both players, so `'xtina'` and her own
  profile id are readable by anyone opening devtools. Nothing in the UI surfaces it.

## Out of scope

- Stats, achievements and streaks for xtina games (deliberately excluded).
- Rematch of an xtina room.
- Any mode with more or fewer than exactly 2 players.
