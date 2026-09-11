-- Room state version — replaces the client's "the Bunch only ever shrinks" heuristic.
--
-- Game.tsx applied a server-reported bunchCount only when it was LOWER than the one already
-- applied, using monotonic shrinkage as a stand-in for response ordering (four independent async
-- writers, no shared sequence). That invariant is false: leave_room returns a departing player's
-- entire rack to the Bunch, so `player_left` legitimately reports a HIGHER count -- which the
-- client then dropped, and went on dropping every subsequent peel/dump report too (all still
-- above the frozen value). Symptoms: a Bunch meter stuck for the rest of the game, and -- worse --
-- canPeel reading a too-low count, so a completed board fired Plantains instead of Peel and got
-- BUNCH_NOT_LOW, which is not in SILENT_ACTION_ERRORS. That is an error banner plus a latched
-- autoSigRef: a finished board that can neither peel nor win.
--
-- Fix: version the room's state for real, so ordering is carried explicitly instead of inferred.
--
-- Deliberately implemented as two triggers rather than by rewriting peel/dump/start_game/
-- leave_room/rematch_room. Those are long function bodies that a `create or replace` would have
-- to reproduce verbatim, and every such copy is a chance to drift (see CLAUDE.md's note on
-- exactly that risk). A trigger also covers every FUTURE writer of bunch_count automatically,
-- which is the property that was missing in the first place.

alter table public.rooms add column state_version int not null default 0;

-- ---------------------------------------------------------------------------
-- Bump the version whenever the Bunch actually changes. BEFORE UPDATE, so the new value is
-- visible to the rest of the same transaction -- every RPC below builds its room_event payload
-- after its bunch write, and reads the fresh version through the room_events trigger.
-- ---------------------------------------------------------------------------
create or replace function public._bump_room_state_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.bunch_count is distinct from old.bunch_count then
    new.state_version := old.state_version + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists rooms_bump_state_version on public.rooms;
create trigger rooms_bump_state_version
  before update on public.rooms
  for each row execute function public._bump_room_state_version();

-- ---------------------------------------------------------------------------
-- Stamp every room_event with the room's state_version at insert time. This is what lets a
-- client order the four independent bunchCount writers against each other without threading a
-- sequence through each RPC by hand. Events that carry no bunchCount (game_over,
-- plantains_rejected, progress) get the field too and simply go unused -- harmless, and it keeps
-- the stamping unconditional rather than a per-type list that a new event type could fall off.
-- ---------------------------------------------------------------------------
create or replace function public._stamp_room_event_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_version int;
begin
  select state_version into v_version from public.rooms where id = new.room_id;
  if v_version is not null then
    new.payload := coalesce(new.payload, '{}'::jsonb)
                   || jsonb_build_object('stateVersion', v_version);
  end if;
  return new;
end;
$$;

drop trigger if exists room_events_stamp_version on public.room_events;
create trigger room_events_stamp_version
  before insert on public.room_events
  for each row execute function public._stamp_room_event_version();

-- ---------------------------------------------------------------------------
-- Expose it on the public view so the initial load has a baseline to compare against.
-- New column at the end, per the same replace-safe pattern 20260719000005 and 20260728000003
-- already used.
-- ---------------------------------------------------------------------------
create or replace view public.rooms_public
with (security_invoker = false) as
  select r.id, r.code, r.host_id, r.status, r.dictionary_config,
         r.bunch_count, r.winner_id, r.created_at, r.started_at, r.finished_at,
         r.mode, r.mode_config, r.state_version
  from public.rooms r
  where public.is_room_member(r.id) or r.host_id = auth.uid();
