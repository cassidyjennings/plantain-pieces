-- Fix: profile_stats.mode rejects 'xtina', silently breaking stat/achievement rollup for every
-- xtina game since it shipped.
--
-- 20260805000001_xtina_roles.sql widened rooms.mode to a third value ('xtina') but never touched
-- profile_stats.mode, whose CHECK constraint (from 20260721000001_solo_mode_schema.sql) is still
-- stuck at ('multiplayer', 'solo'). archive_game inserts v_room.mode straight into
-- profile_stats.mode (see 20260805000002_xtina_deal.sql), so for any room with mode = 'xtina'
-- that INSERT violates the constraint and the whole function throws. The Worker deliberately
-- swallows a rollup failure so it can't fail the win (apps/api/src/index.ts, "A rollup failure
-- must not fail the win") — console.error only, nothing surfaced to the player. Net effect: every
-- xtina game since 2026-08-05 finished normally from the player's side (win screen, Results) but
-- silently wrote zero stats and unlocked zero achievements for both participants. Reproduced
-- directly: an insert with mode = 'xtina' raises
-- `violates check constraint "profile_stats_mode_check"`.
--
-- No backfill is possible — rooms (and the room_events/room_players data archive_game reads) are
-- swept 24h after they finish (20260728000006's _sweep_stale_rooms), so the games already lost to
-- this bug have no server-side trace left to replay.
alter table public.profile_stats drop constraint profile_stats_mode_check;
alter table public.profile_stats
  add constraint profile_stats_mode_check check (mode in ('multiplayer', 'solo', 'xtina'));
