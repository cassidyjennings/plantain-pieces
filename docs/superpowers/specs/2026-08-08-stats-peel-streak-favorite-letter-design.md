# Stats tab: replace choke rate & alphabet letters with peel streak & favorite starting letter

2026-08-08

## Why

Two tiles on the Profile Stats tab (`Choke rate`, `Alphabet letters`) are being swapped for two
more interesting ones: `Best peel streak` and `Favorite starting letter`. This is a stats-content
change, not a bug fix — unrelated to the same-day `profile_stats.mode` CHECK constraint fix.

## Scope

- `profile_stats` schema: drop `choke_count`, add `best_peel_streak` and `first_letter_counts`.
- `archive_game` RPC: drop choke computation, add peel-streak computation.
- `submit_game_summary` RPC: add first-letter frequency tally.
- Client: `ProfileStatsRow` type, `aggregateStats()`, `StatsBoard` tiles.
- One new migration, no other RPCs or tables touched.

## Data model

`profile_stats` (per `(profile_id, mode)`, unchanged key):

- **Drop** `choke_count int`. Nothing else reads it (no achievement depends on it); once the
  `Choke rate` tile is gone it becomes pure write-only dead weight. `archive_game`'s
  `v_min_tiles`/`v_is_choke` computation, which exists solely to feed it, is deleted too.
- **Add** `best_peel_streak int not null default 0` — lifetime-best count of consecutive Peels
  without an intervening Dump, in a single game, **multiplayer mode only** (not solo, not xtina —
  solo has no real "streak" tension, and xtina's peels are scripted rather than earned). Stored as
  a running max via `GREATEST`, same pattern as `fastest_peel_ms`'s running min.
- **Add** `first_letter_counts jsonb not null default '{}'::jsonb` — a per-letter frequency map,
  e.g. `{"A": 4, "S": 7}`, counting how many of a player's valid words started with each letter,
  lifetime. This is new and separate from the existing `first_letters text` column (a plain set of
  letters ever used), which is **unchanged** and keeps backing the `alphabet_soup` achievement
  (26/26 distinct starting letters). Two columns, two purposes: one is a set for a threshold
  achievement, the other is a frequency map for "which letter do you favor."

## Server-side computation

### `archive_game` (server-authoritative half — peels/dumps/wins/streak/achievements)

Runs once per finished room, already loops over each non-spectator player computing peel/dump
*counts* from `room_events`. Peel streak is computed in the same loop, from the same event window
(`created_at >= v_since`), using a standard gaps-and-islands query:

1. Pull that player's `peel`/`dump` events in time order.
2. Run a window `SUM` of a dump indicator (`(type = 'dump')::int`) over all preceding rows — every
   peel between the same pair of dumps shares the same running sum, so grouping by it clusters
   consecutive peels together.
3. `GREATEST(existing best_peel_streak, MAX(group size))`, computed **only when
   `v_room.mode = 'multiplayer'`**; for solo/xtina the streak variable is left at `0`, and
   `GREATEST(existing, 0)` is a no-op — so the INSERT/UPDATE statement doesn't need a separate
   branch per mode, it stays the single existing code path.

Everything else in `archive_game` (achievements, account-wide streak, peels/dumps totals) is
unchanged.

### `submit_game_summary` (client word list, dictionary-filtered)

Already builds `v_valid_words` and folds their first letters into a `first_letters` *set* for the
`alphabet_soup` achievement. Alongside that, unchanged, this adds:

1. Tally this submission's valid words by first letter into a small map
   (`{letter: count_this_game}`).
2. Merge additively into the stored `first_letter_counts`: union of both maps' keys, summing the
   value at each key (existing + this game's tally). Plain SQL over `jsonb_object_keys`, no new
   dependency.

Both RPCs keep their existing idempotency guards (`stats_applied` / `summary_applied`) — this adds
fields to writes that already only happen once per room/player, not new write paths.

## Client

- `ProfileStatsRow` (`apps/web/src/lib/profile.ts`): remove `choke_count` and `first_letters`
  (unused by the client after this — `first_letters` only ever existed to feed the tile being
  removed; the achievement-backing set stays server-side only). Add `best_peel_streak: number` and
  `first_letter_counts: Record<string, number>`.
- `aggregateStats()` (the "All modes" merge across a profile's per-mode rows): drop the
  `choke_count` sum. Add `best_peel_streak` via `Math.max` across rows (mirrors how
  `fastest_peel_ms` already merges via `Math.min`). Add `first_letter_counts` via per-letter sum
  across rows (mirrors the dropped `first_letters` set-union, but summing counts instead of
  unioning a set).
- `StatsBoard` (`apps/web/src/pages/Profile.tsx`): remove the `Alphabet letters` and `Choke rate`
  tiles.
  - **Favorite starting letter**: always shown (not gated by `showCompetitiveStats` — like
    Longest word / Rarest word, it's a lifetime word-shape stat, not a competitive one). Value:
    every letter tied at the max count in `first_letter_counts`, comma-joined (e.g. `"A, S"`);
    `-` if the map is empty (no words yet).
  - **Best peel streak**: gated by `showCompetitiveStats` (hidden on the Solo filter, same as Win
    rate) since it's multiplayer-only by definition. Value: `stats.best_peel_streak`, or `-` when
    `0`.

## Migration

One new file, `supabase/migrations/20260808000002_...sql`, `create or replace` on both RPCs (same
signatures, no overload risk) plus the `alter table profile_stats` schema change. Applied locally
via `db:reset` and verified there first; prod application is the usual manual paste into Studio
(per this repo's deployment convention — migrations are never auto-applied to prod).

## Testing

- Local: `db:reset` applies the migration cleanly (syntax/constraint check).
- Manual smoke test: play a multiplayer game locally with a deliberate peel-peel-dump-peel-peel-peel
  pattern, confirm `best_peel_streak` lands on the longer run (3), not the total peel count (5) or
  the naive first run (2).
- Manual smoke test: form words starting with a repeated letter across two games, confirm
  `first_letter_counts` accumulates (doesn't overwrite) and the UI's tie-break shows multiple
  letters correctly when two are tied.
- Confirm `choke_count`'s removal doesn't break anything else — already verified via repo-wide
  grep: only `Profile.tsx` and `lib/profile.ts` reference "choke" anywhere in `apps/`.
