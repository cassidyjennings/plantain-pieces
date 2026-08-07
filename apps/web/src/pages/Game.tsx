import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  extractWordsWithCells,
  makeKey,
  parseKey,
  validateStructure,
  GRID_SIZE,
  XTINA_STEPS,
  xtinaCellIsScripted,
  xtinaGridMatches,
  xtinaLitCells,
  xtinaHintCells,
  type GridState,
} from '@plantain/shared';
import { api, ApiError } from '../lib/api.js';
import {
  fetchLastPeelActor,
  fetchPlayers,
  fetchRoom,
  type PublicPlayer,
  type PublicRoom,
  type XtinaModeConfig,
} from '../lib/rooms.js';
import { useRoomEvents } from '../hooks/useRoomEvents.js';
import { useMoveTracker } from '../hooks/useMoveTracker.js';
import { useSessionStore } from '../store/sessionStore.js';
import { useSettingsStore } from '../store/settingsStore.js';
import {
  computeUnplaced,
  diffNewLetters,
  insertRackTile,
  moveRackLetterGroup,
  moveRackTile,
  newRackTile,
  trayItems,
  type RackTile,
} from '../lib/rackUtils.js';
import { CELL, WORLD } from '../lib/board.js';
import GameBoard from '../components/GameBoard.js';
import Tray from '../components/Tray.js';
import DragGhost from '../components/DragGhost.js';
import BunchGraphic from '../components/BunchGraphic.js';
import BigCallout from '../components/BigCallout.js';
import InfoTooltip from '../components/InfoTooltip.js';
import ZoomIcon from '../components/ZoomIcon.js';
import BoardModeIcon from '../components/BoardModeIcon.js';
import SliceFlyLayer, { type SliceFlyHandle } from '../components/SliceFlyLayer.js';

/** mm:ss for the Timed solo mode elapsed-time pill. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

const CALLOUT_MS = 900;
/**
 * Auto-fire rejections that are a normal part of building a board, not failures worth a banner.
 * The player is mid-word; the tile colours already say what's wrong. Everything NOT in this set
 * is a real problem (room gone, not a member, server down) and does get surfaced.
 */
const SILENT_ACTION_ERRORS = new Set([
  'TILES_REMAINING',
  'EXTRA_TILES',
  'NOT_CONNECTED',
  'ORPHAN_TILE',
  'EMPTY_GRID',
  'INVALID_WORDS',
  'BUNCH_TOO_LOW',
  'STALE_ACTION',
]);

/** How long an error banner stays up before dismissing itself. */
const ERROR_BANNER_MS = 6000;

/** How many slices SliceFlyLayer flies at once (its MAX_ACTIVE) — bursts queue in waves of this. */
const SLICE_WAVE = 4;
/** One slice's full flight: ~750ms leg A + ~1050ms leg B. */
const SLICE_FLIGHT_MS = 1800;
const DRAG_THRESHOLD = 5;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;
// Flat per-event zoom step (direction only, not magnitude-scaled) — this is what it was
// originally. A magnitude-proportional formula was tried in between, but trackpad wheel events
// typically carry a small deltaY per tick (unlike a single big mouse-wheel notch), so scaling by
// magnitude made continuous trackpad pinch feel sluggish. A flat step feels snappy for both.
const WHEEL_ZOOM_STEP = 1.1;
const BUTTON_ZOOM_STEP = 1.2;
// Trackpads keep sending wheel events with a rapidly-decaying deltaY for a while after the
// user's fingers actually stop (OS-level momentum/inertia) — without a floor, zoom keeps
// gently drifting for a beat after the gesture ends. Ignoring near-zero deltas makes it stop
// as soon as the real gesture tails off instead of chasing that last stretch of momentum.
const MIN_ZOOM_DELTA = 1.5;

/** Stable empty set — a fresh `new Set()` per render would defeat GameBoard's reconciliation. */
const EMPTY_CELLS: Set<string> = new Set();

type DragData =
  | { kind: 'pan'; startX: number; startY: number; startPan: { x: number; y: number } }
  | {
      kind: 'tile';
      source: 'tray' | 'board';
      letter: string;
      id?: string;
      originKey?: string;
      startX: number;
      startY: number;
      moved: boolean;
    }
  | {
      kind: 'pinch';
      /** Screen distance between the two pointers when the pinch began — zoom is always
       * computed as `startZoom * (currentDist / startDist)`, never incrementally from the live
       * zoom, so drift can't accumulate across many pointermove events. */
      startDist: number;
      startZoom: number;
      /** World-space point that sat under the pinch's midpoint at gesture start. Recomputing pan
       * each move to keep this point under the CURRENT midpoint is what makes the gesture zoom
       * under the fingers and pan when the midpoint drifts (a still-distance two-finger drag), in
       * one formula. */
      anchorWorldX: number;
      anchorWorldY: number;
    }
  // --- Select mode only ---------------------------------------------------------------
  | {
      /** Dragging a selection rectangle over empty board space. */
      kind: 'marquee';
      startX: number;
      startY: number;
      moved: boolean;
    }
  | {
      /** Dragging an existing multi-tile selection around. Movement is tracked as a whole-cell
       * (dx, dy) so the preview always lands on the grid the same way the commit will. */
      kind: 'move-selection';
      startX: number;
      startY: number;
      keys: string[];
      moved: boolean;
    };

export default function Game() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const profileId = useSessionStore((s) => s.profileId);
  const wordValidationEnabled = useSettingsStore((s) => s.wordValidationEnabled);
  const boardMode = useSettingsStore((s) => s.boardMode);
  const setBoardMode = useSettingsStore((s) => s.setBoardMode);

  const [grid, setGrid] = useState<GridState>({});
  const [rack, setRack] = useState<RackTile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [bunchCount, setBunchCount] = useState(144);
  const [lastPeelBy, setLastPeelBy] = useState<string | null>(null);
  const [players, setPlayers] = useState<PublicPlayer[]>([]);
  const [room, setRoom] = useState<PublicRoom | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [callout, setCallout] = useState<string | null>(null);
  const [validCells, setValidCells] = useState<Set<string>>(new Set());
  const [wordsPending, setWordsPending] = useState(false);
  /** Whether the current banner is a real failure (louder styling) rather than a neutral note. */
  const [messageIsError, setMessageIsError] = useState(false);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Slice-fly animation: chips waiting for their flying slice to land, chips that were just
  // revealed by a landed slice (so they get a soft settle instead of the drop-in pop — the slice
  // rolling in with the letter already visible *is* their reveal), and a counter that pulses the
  // plantain's cut-flash on each draw.
  const [pendingReveal, setPendingReveal] = useState<Set<string>>(new Set());
  const [sliceRevealed, setSliceRevealed] = useState<Set<string>>(new Set());
  const [flashSignal, setFlashSignal] = useState(0);
  // Holds the completed board on screen instead of navigating to Results — see runAutoAction's
  // Plantains branch below.
  const [xtinaFinished, setXtinaFinished] = useState(false);

  // Select-mode state. `selectedKeys` are committed selections; `marquee` is the live rectangle
  // being dragged (screen coords); `selectionOffset` is the in-flight whole-cell shift of a
  // selection being moved, rendered as a preview until it commits.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [selectionOffset, setSelectionOffset] = useState<{ dx: number; dy: number } | null>(null);

  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [ghost, setGhost] = useState<{ letter: string } | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragData | null>(null);
  const busyRef = useRef(false);
  const autoSigRef = useRef<string | null>(null);
  const centeredRef = useRef(false);
  // Active touch pointers on the board, keyed by pointerId -> last known {x, y}. Only used to
  // detect a second finger landing (promoting whatever single-pointer gesture was in progress to
  // a pinch) and to read both fingers' live positions during one. Desktop mouse/trackpad zoom
  // (ctrlKey + wheel, see onWheel below) doesn't touch this at all.
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  // Slice-fly wiring: the plantain cut-end anchor (slice origin), the animation layer handle, and
  // the set of tile ids we've already launched a slice for (so re-renders don't re-fire).
  const plantainCutRef = useRef<HTMLSpanElement>(null);
  const sliceRef = useRef<SliceFlyHandle>(null);
  const animatedIds = useRef<Set<string>>(new Set());
  // Force-reveal fallback timers (see the slice-fly effect below) — cleared on unmount.
  const revealTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  // Last "tiles remaining" value actually sent to the server, so the debounced report effect
  // below doesn't re-POST a value the server already has (it also dedupes server-side, but this
  // skips the network round-trip entirely on a no-op re-fire).
  const lastReportedRef = useRef<number | null>(null);
  useEffect(() => {
    const timers = revealTimers.current;
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  // Mirror the latest values into refs so the window pointer handlers (attached once) read fresh.
  const gridRef = useRef(grid);
  const rackRef = useRef(rack);
  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  const collapsedRef = useRef(collapsed);
  const playersRef = useRef(players);
  const bunchRef = useRef(bunchCount);
  const boardModeRef = useRef(boardMode);
  const selectedKeysRef = useRef(selectedKeys);
  const selectionOffsetRef = useRef(selectionOffset);
  gridRef.current = grid;
  rackRef.current = rack;
  panRef.current = pan;
  zoomRef.current = zoom;
  collapsedRef.current = collapsed;
  playersRef.current = players;
  bunchRef.current = bunchCount;
  boardModeRef.current = boardMode;
  selectedKeysRef.current = selectedKeys;
  selectionOffsetRef.current = selectionOffset;

  // Per-game move tracking → the client end-of-game summary (words, placed count, move stats).
  const moveTracker = useMoveTracker(grid, rack);
  const summarySubmittedRef = useRef(false);

  function fireCallout(text: string) {
    setCallout(text);
    setTimeout(() => setCallout((c) => (c === text ? null : c)), CALLOUT_MS);
  }

  // Reveal a chip once its flying slice has landed: unhide it and mark it as slice-delivered (a
  // soft settle instead of the drop-in pop, since the rolling slice already showed its letter).
  const revealChip = useCallback((id: string) => {
    setPendingReveal((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setSliceRevealed((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  // Fire the slice-fly animation for each newly *drawn* tile. `justDrawn` is set only for genuine
  // draws (Peel/Dump) — tiles moved back from the board or recalled use newRackTile (no flag), so
  // this correctly ignores those. Peel adds 1 tile → 1 slice; Dump adds 3 → 3 staggered slices.
  //
  // This is a layout effect (not a regular effect) so that `pendingReveal` is updated — and Tray
  // re-rendered with the fresh chips already hidden — before the browser ever paints a frame.
  // With a regular effect, the first paint briefly shows the fresh chips as `.just-drawn` (mid
  // tileDrop's scale-from-0.4 keyframe) before the *next* render swaps them to `.pending`; the
  // flying slice's size measurement could land inside that transient scaled-down frame, which is
  // what caused the first slice of a multi-tile Dump to consistently come out too small.
  useLayoutEffect(() => {
    // Prune ids that have left the rack (placed on the board) so the guard sets can't grow forever.
    const liveIds = new Set(rack.map((t) => t.id));
    for (const id of animatedIds.current) {
      if (!liveIds.has(id)) animatedIds.current.delete(id);
    }
    setSliceRevealed((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of prev) {
        if (!liveIds.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    const fresh = rack.filter((t) => t.justDrawn && !animatedIds.current.has(t.id));
    if (fresh.length === 0) return;
    fresh.forEach((t) => animatedIds.current.add(t.id));

    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // In expanded mode each fresh tile has its own chip, hidden by id until its slice lands. In
    // collapsed mode duplicates share one group chip instead — trayItems() uses this same
    // pendingIds set to exclude in-flight tiles from that group's displayed count, so a
    // duplicate letter's badge doesn't jump to the new total before the slice visually arrives.
    // Peel deals 1 tile and Dump deals 3, which is what the flat 180ms stagger was tuned for.
    // Xtina mode deals a whole word at once — up to 10 — and SliceFlyLayer only flies MAX_ACTIVE
    // (4) at a time, so a big burst queues in waves. At 180ms apart a 10-tile deal ran well past
    // the old fixed 3500ms safety net, which then fired mid-flight and snapped the last tiles
    // into the tray while their slices were still traveling. Tighten the stagger once a burst is
    // bigger than one wave, and size the net to the burst actually launched.
    const stagger = fresh.length > 1 ? (fresh.length > SLICE_WAVE ? 70 : 180) : 0;
    const flightWaves = Math.ceil(fresh.length / SLICE_WAVE);
    const revealFallbackMs = SLICE_FLIGHT_MS * flightWaves + stagger * fresh.length + 1200;

    if (!reduce) {
      setPendingReveal((prev) => {
        const next = new Set(prev);
        fresh.forEach((t) => next.add(t.id));
        return next;
      });
      // Safety net: whatever the cause (a backgrounded tab pausing requestAnimationFrame, a
      // dropped WAAPI animation, anything else that can stop a flight short of landing), a tile
      // must never stay hidden/uncounted forever just because its slice never finished.
      fresh.forEach((t) => {
        const timer = setTimeout(() => revealChip(t.id), revealFallbackMs);
        revealTimers.current.add(timer);
      });
    }
    setFlashSignal((s) => s + 1);

    sliceRef.current?.launch({
      from: () => plantainCutRef.current?.getBoundingClientRect() ?? null,
      to: (i) => {
        const t = fresh[i];
        const selector = collapsed ? `[data-letter="${t.letter}"]` : `[data-tile-id="${t.id}"]`;
        const el = document.querySelector(selector);
        if (!el) return null;
        return { rect: el.getBoundingClientRect(), fontSize: getComputedStyle(el).fontSize };
      },
      letters: fresh.map((t) => t.letter),
      count: fresh.length,
      staggerMs: stagger,
      onLanded: (i) => revealChip(fresh[i].id),
    });
  }, [rack, collapsed, revealChip]);

  const loadState = useCallback(async () => {
    if (!roomId) return;
    const [state, roomData, playerList, lastPeel] = await Promise.all([
      api.getMyState(roomId),
      fetchRoom(roomId),
      fetchPlayers(roomId),
      fetchLastPeelActor(roomId),
    ]);
    setGrid(state.grid);
    setRack(computeUnplaced(state.rack, state.grid));
    setPlayers(playerList);
    setLastPeelBy(lastPeel);
    if (roomData) {
      setBunchCount(roomData.bunch_count);
      setRoom(roomData);
    }
  }, [roomId]);

  // --- Xtina mode ------------------------------------------------------------
  // Everything here is presentation over an otherwise ordinary game: the server already dealt
  // the scripted tiles, and the board, tray and drag system are untouched. Only the partner
  // sees hints — the owner is playing a real (unwinnable) game.
  //
  // Declared this high in the component on purpose: the realtime handler, `invalidPlacedCount`
  // and the auto-fire effect all read these, and a `const` referenced from a dependency array
  // must be initialized before that array is evaluated during render.
  const xtinaConfig = room?.mode === 'xtina' ? (room.mode_config as XtinaModeConfig) : null;
  const isXtina = xtinaConfig !== null;
  const isXtinaPartner = isXtina && xtinaConfig.partnerId === profileId;
  const xtinaStep = xtinaConfig?.step ?? 0;

  // Hints are for the word whose tiles are in the tray RIGHT NOW (step), not the next one.
  // They vanish once those cells are filled, so a correctly-placed word leaves a clean board
  // until the peel lands and the next set appears.
  const xtinaHints = useMemo(() => {
    if (!isXtinaPartner || xtinaStep < 1 || xtinaStep > XTINA_STEPS) return EMPTY_CELLS;
    const pending = [...xtinaHintCells(xtinaStep)].filter((k) => !(k in grid));
    return pending.length > 0 ? new Set(pending) : EMPTY_CELLS;
  }, [isXtinaPartner, xtinaStep, grid]);

  // An accent word lights only once it is COMPLETE. LOVE's L is BEAUTIFUL's L and lands at step 2
  // — eight words before LOVE exists — so lighting the static accent set flared that tile orange
  // early and gave the ending away.
  const xtinaAccents = useMemo(
    () => (isXtinaPartner ? xtinaLitCells(grid) : EMPTY_CELLS),
    [isXtinaPartner, grid],
  );

  /**
   * "Is this cell part of a word we're happy with?" — the single test behind auto-fire, the
   * "tiles remaining" count and Recall invalid.
   *
   * For an ordinary game that is dictionary validity, unchanged.
   *
   * For the xtina partner it deliberately is NOT. Her board is scripted end to end, so "is this
   * tile where the script wants it" is a strictly STRONGER statement than "is this tile part of a
   * word the dictionary knows" — and unlike the dictionary it cannot be knocked out by which word
   * lists a room has enabled. Routing her through the dictionary was a real soft-lock: YOURE isn't
   * in Collins/SOWPODS at all, and during testing an unseeded local `words` table made *every*
   * word invalid, which silently froze the script at word two with no error and no way forward.
   * Green tinting is unaffected — it reads `validCells` directly, so her other nine words still
   * have to earn their tint.
   */
  const cellIsGood = useCallback(
    (k: string) => (isXtinaPartner ? xtinaCellIsScripted(k, grid[k]) : validCells.has(k)),
    [isXtinaPartner, grid, validCells],
  );

  // Timed solo mode: a live elapsed-time ticker from the room's started_at. Zen mode and
  // multiplayer show nothing (mode_config.timed is only ever true for solo).
  const isTimed = room?.mode === 'solo' && (room.mode_config as { timed?: boolean }).timed === true;
  // The Bunch meter fills against the room's OWN starting size -- a solo player's smaller chosen
  // Bunch (as low as 54) must still read as a whole, full plantain at the start, just one that
  // empties faster, not a plantain that's already partly eaten before a single tile is drawn.
  const startingBunchCount =
    room?.mode === 'solo' ? ((room.mode_config as { bunchSize?: number }).bunchSize ?? bunchCount) : undefined;
  useEffect(() => {
    if (!isTimed || !room?.started_at) return;
    const startedAt = new Date(room.started_at).getTime();
    const tick = () => setElapsedMs(Date.now() - startedAt);
    tick();
    const handle = setInterval(tick, 1000);
    return () => clearInterval(handle);
  }, [isTimed, room?.started_at]);

  useEffect(() => {
    loadState();
  }, [loadState]);

  // Center the world in the viewport once we know its size.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || centeredRef.current) return;
    const rect = vp.getBoundingClientRect();
    if (rect.width === 0) return;
    // Round to whole device pixels — a fractional pan offset makes the 1px grid-line
    // background render blurry/uneven (some lines thin, some doubled) since the repeating
    // gradient no longer lands on pixel boundaries. See onPointerMove/onWheel below for the
    // same rounding on every other pan/zoom update.
    setPan({ x: Math.round(rect.width / 2 - WORLD / 2), y: Math.round(rect.height / 2 - WORLD / 2) });
    centeredRef.current = true;
  }, [grid]);

  // Submit this player's end-of-game summary exactly once — the winner submits from its own
  // plantains response, losers from the game_over event, whichever fires first. Both are keyed
  // by room now (nothing per-game is stored), so the only guard needed is against a double
  // submit; the server is idempotent regardless.
  function submitSummaryOnce() {
    if (!roomId || summarySubmittedRef.current) return;
    summarySubmittedRef.current = true;
    // Words and move stats roll into lifetime profile stats and are then forgotten.
    api.submitGameSummary(roomId, moveTracker.buildSummary(gridRef.current)).catch(() => {});
    // The board is a separate call because it has a different lifetime: it's persisted to the
    // room for the post-game viewer and deleted along with it, never rolled into anything.
    api.persistFinalGrid(roomId, gridRef.current).catch(() => {});
  }

  useRoomEvents(roomId, (event) => {
    if (event.type === 'game_over') {
      submitSummaryOnce();
      // room_events are delivered to the actor too (see the actor !== profileId guard on `peel`
      // below), so the partner receives this broadcast right after her own Plantains response
      // already set xtinaFinished. Navigating here would yank her straight off the held board
      // and its "View the board" button — the entire point of the mode — a fraction of a second
      // after it appeared. Hold the board instead; she leaves it on her own.
      if (isXtinaPartner) {
        setXtinaFinished(true);
        return;
      }
      navigate(`/room/${roomId}/results`, { replace: true });
      return;
    }
    if (
      event.type === 'peel' ||
      event.type === 'dump' ||
      event.type === 'game_started' ||
      event.type === 'player_left' ||
      event.type === 'progress'
    ) {
      // progress events carry no bunchCount (just profileId/remaining) — this guard simply
      // no-ops for them, which is correct; they only need the player-list refetch below so an
      // opponent's pill picks up their new remaining_count.
      const payload = event.payload as { bunchCount?: number };
      if (typeof payload.bunchCount === 'number') setBunchCount(payload.bunchCount);
      if (roomId) fetchPlayers(roomId).then(setPlayers);
    }
    if (event.type === 'peel') {
      // The room row itself changes on a Peel in xtina mode: the RPC increments
      // mode_config.step. `room` is otherwise fetched exactly once (loadState), so without this
      // the client's step freezes at 1 forever — hints stay pinned to word 1's now-filled cells
      // and the placement gate keeps comparing word 2..10 against word 1's target, which can
      // never match. That's a silent soft-lock: no peel, no error, no way forward. Runs for
      // every player and every mode; for a non-xtina room it's just a cheap row refresh.
      if (roomId) fetchRoom(roomId).then((r) => r && setRoom(r));
      const payload = event.payload as { actor?: string };
      if (payload.actor) setLastPeelBy(payload.actor);
      if (payload.actor && payload.actor !== profileId && roomId) {
        // A Peel deals a tile to EVERYONE, so everyone gets the callout — it's the signal that
        // your own rack just changed, not a notification about who did it. Deliberately no actor
        // name: the "Last peel" pill already answers that, and a name would make the string long
        // enough to overflow a phone. Guarded on actor !== self because the peeler already fired
        // this locally from runAutoAction; without the guard they'd get two.
        fireCallout('PEEL!');
        // Peel deals a new tile to EVERY player, not just whoever called it. The peeler's own
        // client already applied its updated rack from the API response directly; everyone
        // else only learns a peel happened via this broadcast (which is public-safe and
        // carries no private rack data), so pull our own state to pick up the tile we were
        // just dealt. Without this, a bystander's tray silently never got their new tile: no
        // draw animation fired for them, and their now-stale rack went on to fail the
        // server's authoritative rack check on their next Peel/Plantains attempt.
        api.getMyState(roomId).then((state) => {
          const priorRack = [...rackRef.current.map((t) => t.letter), ...Object.values(gridRef.current)];
          const newLetters = diffNewLetters(priorRack, state.rack);
          setRack(computeUnplaced(state.rack, gridRef.current, newLetters, rackRef.current));
        });
      }
    }
    if (event.type === 'plantains_rejected') {
      const payload = event.payload as { actor: string; reason: string };
      if (payload.actor !== profileId) {
        setMessage(`Someone's Plantains! call was rejected (${payload.reason}). Keep playing.`);
      }
    }
  });

  // --- Coordinate helpers ----------------------------------------------------

  const screenToCell = useCallback((clientX: number, clientY: number) => {
    const vp = viewportRef.current;
    if (!vp) return null;
    const rect = vp.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return null;
    }
    const worldX = (clientX - rect.left - panRef.current.x) / zoomRef.current;
    const worldY = (clientY - rect.top - panRef.current.y) / zoomRef.current;
    const cx = Math.floor(worldX / CELL);
    const cy = Math.floor(worldY / CELL);
    if (cx < 0 || cy < 0) return null;
    return { x: cx, y: cy };
  }, []);

  /** Screen point -> world coordinates, unclamped (no viewport-bounds or negative rejection).
   * screenToCell deliberately returns null outside the board; a marquee needs the raw value so a
   * drag that strays past the edge still produces a sane rectangle. */
  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const vp = viewportRef.current;
    if (!vp) return { x: 0, y: 0 };
    const rect = vp.getBoundingClientRect();
    return {
      x: (clientX - rect.left - panRef.current.x) / zoomRef.current,
      y: (clientY - rect.top - panRef.current.y) / zoomRef.current,
    };
  }, []);

  /** Grid keys whose cell intersects the screen-space rectangle between two points. */
  const keysInRect = useCallback(
    (ax: number, ay: number, bx: number, by: number) => {
      const p1 = screenToWorld(ax, ay);
      const p2 = screenToWorld(bx, by);
      const minX = Math.min(p1.x, p2.x), maxX = Math.max(p1.x, p2.x);
      const minY = Math.min(p1.y, p2.y), maxY = Math.max(p1.y, p2.y);
      const hits = new Set<string>();
      for (const key of Object.keys(gridRef.current)) {
        const { x, y } = parseKey(key);
        // A cell counts as hit when the rectangle overlaps it at all, not just its centre —
        // brushing across a row should pick up every tile the box visibly touches.
        const left = x * CELL, top = y * CELL;
        if (left + CELL > minX && left < maxX && top + CELL > minY && top < maxY) hits.add(key);
      }
      return hits;
    },
    [screenToWorld],
  );

  /** Insertion index within the tray for a drop at clientX, ignoring the dragged tile itself. */
  function trayIndexAt(clientX: number, draggedId?: string): number {
    const tiles = Array.from(document.querySelectorAll<HTMLElement>('.tile-rack[data-tray] .tile-chip'));
    let index = 0;
    for (const el of tiles) {
      if (el.dataset.tileId === draggedId) continue;
      const rect = el.getBoundingClientRect();
      if (clientX > rect.left + rect.width / 2) index++;
      else break;
    }
    return index;
  }

  function isOverTray(clientX: number, clientY: number): boolean {
    const dock = document.querySelector<HTMLElement>('.rack-dock');
    if (!dock) return false;
    const r = dock.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  // --- Drag lifecycle (window-level move/up, attached once) -------------------

  /** Restore a lifted board tile and clear drag visuals when a gesture is pre-empted (a second
   * finger promoting a drag to a pinch, or a pointercancel). Shared by both call sites so the
   * "put the tile back" logic can't drift out of sync between them. */
  const abortTileDrag = useCallback((d: DragData | null) => {
    if (d?.kind === 'tile' && d.moved && d.source === 'board' && d.originKey) {
      setGrid((g) => ({ ...g, [d.originKey!]: d.letter }));
    }
    // A marquee or selection-move interrupted by a second finger is abandoned, not committed —
    // the gesture became a pinch, so the player never released on a chosen result.
    setMarquee(null);
    setSelectionOffset(null);
    setGhost(null);
    setDraggingId(null);
  }, []);

  /** Enter pinch mode from the two pointers currently tracked. Called once a second finger lands
   * on the board (see the viewport's capture-phase pointerdown below). Pre-empts whatever
   * single-pointer gesture (pan or tile drag) the first finger had started. */
  const beginPinch = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp || pointersRef.current.size < 2) return;
    const [p1, p2] = [...pointersRef.current.values()];
    const rect = vp.getBoundingClientRect();
    const midX = (p1.x + p2.x) / 2 - rect.left;
    const midY = (p1.y + p2.y) / 2 - rect.top;
    abortTileDrag(dragRef.current);
    dragRef.current = {
      kind: 'pinch',
      // Floor of 1: two fingers landing at (near-)identical points would otherwise divide by
      // ~0 on the very next move event and send the zoom factor to infinity.
      startDist: Math.max(Math.hypot(p2.x - p1.x, p2.y - p1.y), 1),
      startZoom: zoomRef.current,
      anchorWorldX: (midX - panRef.current.x) / zoomRef.current,
      anchorWorldY: (midY - panRef.current.y) / zoomRef.current,
    };
  }, [abortTileDrag]);

  const handleMove = useCallback((e: globalThis.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'pinch') {
      const vp = viewportRef.current;
      if (!vp) return;
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = [...pointersRef.current.values()];
      if (pts.length < 2) return; // the partner finger hasn't reported a move yet
      const [p1, p2] = pts;
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, d.startZoom * (dist / d.startDist)));
      const rect = vp.getBoundingClientRect();
      const midX = (p1.x + p2.x) / 2 - rect.left;
      const midY = (p1.y + p2.y) / 2 - rect.top;
      setZoom(newZoom);
      setPan({
        x: Math.round(midX - d.anchorWorldX * newZoom),
        y: Math.round(midY - d.anchorWorldY * newZoom),
      });
      return;
    }
    if (d.kind === 'pan') {
      setPan({
        x: Math.round(d.startPan.x + (e.clientX - d.startX)),
        y: Math.round(d.startPan.y + (e.clientY - d.startY)),
      });
      return;
    }
    if (d.kind === 'marquee') {
      const vp = viewportRef.current;
      if (!vp) return;
      d.moved = true;
      const rect = vp.getBoundingClientRect();
      // Stored relative to the viewport so the overlay can be positioned without re-reading
      // the rect on every render.
      setMarquee({
        x: Math.min(d.startX, e.clientX) - rect.left,
        y: Math.min(d.startY, e.clientY) - rect.top,
        w: Math.abs(e.clientX - d.startX),
        h: Math.abs(e.clientY - d.startY),
      });
      // Live preview of what would be selected on release.
      setSelectedKeys(keysInRect(d.startX, d.startY, e.clientX, e.clientY));
      return;
    }
    if (d.kind === 'move-selection') {
      if (!d.moved) {
        const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
        if (dist <= DRAG_THRESHOLD) return;
        d.moved = true;
      }
      // Whole-cell steps only: the preview must land exactly where the commit will, so it's
      // rounded here rather than following the pointer continuously and snapping at the end.
      setSelectionOffset({
        dx: Math.round((e.clientX - d.startX) / (CELL * zoomRef.current)),
        dy: Math.round((e.clientY - d.startY) / (CELL * zoomRef.current)),
      });
      return;
    }
    if (!d.moved) {
      const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
      if (dist <= DRAG_THRESHOLD) return;
      d.moved = true;
      setGhost({ letter: d.letter });
      if (d.source === 'tray' && d.id) setDraggingId(d.id);
      // Lift a board tile out of the grid so it follows the pointer.
      if (d.source === 'board' && d.originKey) {
        setGrid((g) => {
          const next = { ...g };
          delete next[d.originKey!];
          return next;
        });
      }
    }
    setPointer({ x: e.clientX, y: e.clientY });
  }, [keysInRect]);

  const handleUp = useCallback(
    (e: globalThis.PointerEvent) => {
      pointersRef.current.delete(e.pointerId);
      const d = dragRef.current;

      if (d?.kind === 'pinch') {
        // A pinch never represents a tile action, so there's nothing to "drop". Below 2 fingers
        // the gesture is over; per design a lone remaining finger does NOT get reinterpreted as
        // starting a fresh pan/tile drag — it just sits there until its own pointerup arrives.
        if (pointersRef.current.size < 2) dragRef.current = null;
        return;
      }

      dragRef.current = null;
      setGhost(null);
      setDraggingId(null);
      if (!d || d.kind === 'pan') return;

      if (d.kind === 'marquee') {
        setMarquee(null);
        // A drag already replaced the selection live in handleMove. A press with no movement is
        // a tap on empty space, which means "deselect". Clearing on pointerDOWN instead would
        // wipe the selection every time someone starts a two-finger pinch, since the first
        // finger inevitably lands before the second.
        if (!d.moved) setSelectedKeys(new Set());
        return;
      }

      if (d.kind === 'move-selection') {
        const offset = selectionOffsetRef.current;
        setSelectionOffset(null);
        // A click on a selected tile without dragging clears the selection — the natural
        // "put it down / never mind" gesture.
        if (!d.moved || !offset || (offset.dx === 0 && offset.dy === 0)) {
          setSelectedKeys(new Set());
          return;
        }
        const { dx, dy } = offset;
        const moving = new Set(d.keys);
        const g = gridRef.current;

        // All-or-nothing: every target cell must be in bounds and either empty or vacated by
        // another tile in this same selection. A partial move would silently shred a word.
        const targets = d.keys.map((key) => {
          const { x, y } = parseKey(key);
          return { from: key, x: x + dx, y: y + dy };
        });
        const ok = targets.every(({ x, y }) => {
          if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) return false;
          const destKey = makeKey(x, y);
          return !g[destKey] || moving.has(destKey);
        });
        if (!ok) {
          // Bounced — keep the selection so the player can just try a different spot.
          return;
        }

        setGrid((prev) => {
          const next = { ...prev };
          for (const key of d.keys) delete next[key];
          for (const t of targets) next[makeKey(t.x, t.y)] = prev[t.from];
          return next;
        });
        setSelectedKeys(new Set(targets.map((t) => makeKey(t.x, t.y))));
        return;
      }

      if (!d.moved) {
        // A click, not a drag.
        if (d.source === 'tray' && d.id) {
          setSelectedId((s) => (s === d.id ? null : d.id!));
        } else if (d.source === 'board' && d.originKey) {
          // Pick the tile up back into the tray.
          setGrid((g) => {
            const next = { ...g };
            delete next[d.originKey!];
            return next;
          });
          setRack((r) => [...r, newRackTile(d.letter)]);
        }
        return;
      }

      const cell = screenToCell(e.clientX, e.clientY);
      if (cell) {
        const key = makeKey(cell.x, cell.y);
        const occupied = !!gridRef.current[key];
        if (!occupied) {
          setGrid((g) => ({ ...g, [key]: d.letter }));
          if (d.source === 'tray' && d.id) setRack((r) => r.filter((t) => t.id !== d.id));
          setSelectedId(null);
          return;
        }
        // Target occupied → bounce back to origin.
      }

      if (isOverTray(e.clientX, e.clientY)) {
        const idx = trayIndexAt(e.clientX, d.id);
        if (d.source === 'board') {
          const tile = newRackTile(d.letter);
          setRack((r) => (collapsedRef.current ? [...r, tile] : insertRackTile(r, tile, idx)));
        } else if (d.source === 'tray' && d.id) {
          setRack((r) =>
            collapsedRef.current ? moveRackLetterGroup(r, d.letter, idx) : moveRackTile(r, d.id!, idx),
          );
        }
        return;
      }

      // Dropped in limbo → return to origin.
      if (d.source === 'board' && d.originKey) {
        setGrid((g) => ({ ...g, [d.originKey!]: d.letter }));
      }
    },
    [screenToCell],
  );

  /** A pointer vanishing without a proper up (browser takes over the gesture, OS interrupts a
   * touch, etc). Unlike handleUp this never attempts a drop — just cancels whatever was live. */
  const handlePointerCancel = useCallback(
    (e: globalThis.PointerEvent) => {
      pointersRef.current.delete(e.pointerId);
      const d = dragRef.current;
      if (d?.kind === 'pinch') {
        if (pointersRef.current.size < 2) dragRef.current = null;
        return;
      }
      abortTileDrag(d);
      dragRef.current = null;
    },
    [abortTileDrag],
  );

  useEffect(() => {
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, [handleMove, handleUp, handlePointerCancel]);

  /** Capture-phase pointerdown on the board viewport (wired via GameBoard's
   * onViewportPointerDownCapture) — this is what makes a second finger reliably promote to a
   * pinch. It has to run in the CAPTURE phase specifically: onBoardTilePointerDown below calls
   * stopPropagation(), which would otherwise stop a same-phase/bubble listener on an ancestor
   * from ever seeing the event; capture runs top-down before the event reaches the tile at all,
   * so it can't be blocked that way. Scoped to the board viewport only — a second finger landing
   * on the tray while dragging on the board (or vice versa) isn't treated as a pinch. */
  function onViewportPointerDownCapture(e: PointerEvent) {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) beginPinch();
  }

  function onTrayPointerDown(id: string, e: PointerEvent) {
    if (pointersRef.current.size >= 2) return; // a pinch already owns this gesture
    const tile = rack.find((t) => t.id === id);
    if (!tile) return;
    e.preventDefault();
    dragRef.current = {
      kind: 'tile',
      source: 'tray',
      letter: tile.letter,
      id,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
  }

  function onBoardTilePointerDown(key: string, e: PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (pointersRef.current.size >= 2) return; // onViewportPointerDownCapture already started a pinch
    const letter = grid[key];
    if (!letter) return;

    if (boardMode === 'select') {
      // Grabbing a tile that's part of the selection moves the whole set. Grabbing one outside
      // it means the player is after that tile specifically, so drop the old selection and fall
      // through to the ordinary single-tile drag.
      if (selectedKeys.has(key)) {
        dragRef.current = {
          kind: 'move-selection',
          startX: e.clientX,
          startY: e.clientY,
          keys: [...selectedKeys],
          moved: false,
        };
        return;
      }
      setSelectedKeys(new Set());
    }

    dragRef.current = {
      kind: 'tile',
      source: 'board',
      letter,
      originKey: key,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
  }

  function onBackgroundPointerDown(e: PointerEvent) {
    if (pointersRef.current.size >= 2) return; // onViewportPointerDownCapture already started a pinch
    if (boardMode === 'select') {
      // In select mode this gesture draws a box instead of panning. The view stays put —
      // zoom buttons, wheel and pinch still work, only drag-to-pan is taken over.
      // The existing selection is deliberately NOT cleared here; see handleUp.
      dragRef.current = { kind: 'marquee', startX: e.clientX, startY: e.clientY, moved: false };
      return;
    }
    dragRef.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, startPan: pan };
  }

  /** Zoom by `factor`, keeping the world point under (anchorClientX, anchorClientY) fixed on
   * screen. Shared by wheel-zoom, ctrl+wheel-zoom, and the +/- buttons (anchored at the
   * viewport's own center for the latter, since a button click has no cursor position). */
  const zoomAtPoint = useCallback(
    (factor: number, anchorClientX: number, anchorClientY: number) => {
      const vp = viewportRef.current;
      if (!vp) return;
      const rect = vp.getBoundingClientRect();
      const px = anchorClientX - rect.left;
      const py = anchorClientY - rect.top;
      const oldZoom = zoomRef.current;
      const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, oldZoom * factor));
      const worldX = (px - panRef.current.x) / oldZoom;
      const worldY = (py - panRef.current.y) / oldZoom;
      setZoom(newZoom);
      setPan({ x: Math.round(px - worldX * newZoom), y: Math.round(py - worldY * newZoom) });
    },
    [],
  );

  const onWheel = useCallback(
    (e: globalThis.WheelEvent) => {
      // Must be a non-passive native listener (see the effect below) — React's synthetic
      // onWheel is registered passive by default, which silently drops preventDefault() and
      // lets the browser's own pinch/ctrl+wheel zoom the whole page instead of just the board.
      e.preventDefault();
      const isPinchOrCtrlZoom = e.ctrlKey; // trackpad pinch and mouse "ctrl+wheel" both report ctrlKey
      if (isPinchOrCtrlZoom) {
        // Skip the tail end of trackpad momentum instead of chasing it down to zero.
        if (Math.abs(e.deltaY) < MIN_ZOOM_DELTA) return;
        const factor = e.deltaY > 0 ? 1 / WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP;
        zoomAtPoint(factor, e.clientX, e.clientY);
        return;
      }
      // Two-finger trackpad scroll (both fingers moving the same direction) or a plain mouse
      // wheel — pan instead of zoom, using both axes so trackpad horizontal scroll pans sideways.
      setPan((p) => ({ x: Math.round(p.x - e.deltaX), y: Math.round(p.y - e.deltaY) }));
    },
    [zoomAtPoint],
  );

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  function handleZoomButton(direction: 1 | -1) {
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const factor = direction > 0 ? BUTTON_ZOOM_STEP : 1 / BUTTON_ZOOM_STEP;
    zoomAtPoint(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  // --- Live word validation (debounced) --------------------------------------

  useEffect(() => {
    if (!roomId) return;
    // Word validation off: never fetch or tint — the auto-fire effect below bypasses the word
    // gate entirely in this mode, so there's nothing for these to feed.
    if (!wordValidationEnabled) {
      setValidCells(new Set());
      setWordsPending(false);
      return;
    }
    const words = extractWordsWithCells(grid);
    if (words.length === 0) {
      setValidCells(new Set());
      setWordsPending(false);
      return;
    }
    // Flip to "pending" synchronously, in the same effect that (re)starts the debounce timer,
    // so there's no window where wordsPending reads false while validCells is still stale for
    // the current grid — that gap is exactly what let auto-Peel fire on unchecked words before.
    setWordsPending(true);
    const handle = setTimeout(async () => {
      try {
        const unique = [...new Set(words.map((w) => w.word))];
        const { invalidWords } = await api.validate(roomId, unique);
        const invalid = new Set(invalidWords);
        // A cell at the intersection of two words (one across, one down) must only tint
        // green/count as valid if BOTH words through it are valid. Adding a word's cells
        // whenever that word alone was valid let an invalid word's cells slip through
        // whenever every one of them happened to also belong to a separate valid word
        // crossing it -- masking the bad word entirely and letting auto-Peel/Plantains fire
        // on a grid that still had a real invalid word on it.
        const badCells = new Set<string>();
        for (const w of words) {
          if (invalid.has(w.word)) for (const c of w.cells) badCells.add(c);
        }
        const cells = new Set<string>();
        for (const w of words) {
          if (!invalid.has(w.word)) for (const c of w.cells) if (!badCells.has(c)) cells.add(c);
        }
        setValidCells(cells);
      } catch {
        /* transient — leave previous highlight */
      } finally {
        setWordsPending(false);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [grid, roomId, wordValidationEnabled]);

  // Drop selected cells that no longer hold a tile — recalling invalid tiles, or dragging one
  // out of the group individually, can empty a cell that's still selected. A stale key would
  // otherwise survive into a selection move and write `undefined` into the grid.
  useEffect(() => {
    setSelectedKeys((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((k) => grid[k] !== undefined));
      return next.size === prev.size ? prev : next;
    });
  }, [grid]);

  // --- Publish "tiles remaining" so opponent pills mean something ------------

  // Tray tiles + placed tiles not currently part of a valid word. With word validation off,
  // validCells is never populated (see above), so every placed tile would misread as "invalid" —
  // there's no such distinction in that mode, so nothing counts as invalid-placed there.
  const invalidPlacedCount = wordValidationEnabled
    ? Object.keys(grid).filter((k) => !cellIsGood(k)).length
    : 0;
  const remainingCount = rack.length + invalidPlacedCount;

  useEffect(() => {
    if (!roomId) return;
    const handle = setTimeout(() => {
      // Skip a report that lands mid-action (Peel/Dump/Plantains) rather than racing it — rack
      // and grid are mid-update across several setState calls right then, so remainingCount can
      // be transiently wrong. Nothing is lost: the settle after the action changes remainingCount
      // again (or doesn't, in which case the stale number was already correct), re-firing this
      // same effect.
      if (busyRef.current) return;
      if (lastReportedRef.current === remainingCount) return;
      lastReportedRef.current = remainingCount;
      api.reportProgress(roomId, remainingCount).catch(() => {
        // Let a future change retry; an ApiError here would otherwise permanently believe the
        // server has a value it never actually received.
        lastReportedRef.current = null;
      });
    }, 1000);
    return () => clearTimeout(handle);
  }, [remainingCount, roomId]);

  // --- Auto-detect Peel / Plantains ------------------------------------------

  const runAutoAction = useCallback(async () => {
    if (busyRef.current || !roomId) return;
    const submittedGrid = gridRef.current;
    const activeCount = playersRef.current.filter((p) => !p.is_spectator).length || 1;
    const canPeel = bunchRef.current >= activeCount;
    busyRef.current = true;
    setMessage(null);
    try {
      if (canPeel) {
        const priorRack = [
          ...rackRef.current.map((t) => t.letter),
          ...Object.values(submittedGrid),
        ];
        const result = await api.peel(roomId, submittedGrid);
        const newLetters = diffNewLetters(priorRack, result.rack);
        setRack(computeUnplaced(result.rack, submittedGrid, newLetters, rackRef.current));
        setBunchCount(result.bunchCount);
        fireCallout('PEEL!');
      } else {
        await api.plantains(roomId, submittedGrid);
        submitSummaryOnce();
        fireCallout('PLANTAINS!');
        if (isXtinaPartner) {
          // Hold the completed board on screen rather than yanking her to a scoreboard. The
          // Plantains call already persisted the grid, so the board viewer below has something
          // to show whenever she chooses to open it.
          setXtinaFinished(true);
        } else {
          setTimeout(() => navigate(`/room/${roomId}/results`, { replace: true }), CALLOUT_MS);
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.message === 'BUNCH_TOO_LOW') {
        // Someone peeled the Bunch dry between our check and call — go for the win instead.
        try {
          await api.plantains(roomId, submittedGrid);
          submitSummaryOnce();
          fireCallout('PLANTAINS!');
          setTimeout(() => navigate(`/room/${roomId}/results`, { replace: true }), CALLOUT_MS);
        } catch (err2) {
          reportActionError(err2);
        }
      } else {
        reportActionError(err);
      }
    } finally {
      busyRef.current = false;
    }
  }, [roomId, navigate, isXtinaPartner]);

  /** Drop an error banner over the board, and clear it on its own so it can't linger. */
  function showError(text: string) {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setMessageIsError(true);
    setMessage(text);
    errorTimer.current = setTimeout(() => {
      setMessage(null);
      setMessageIsError(false);
    }, ERROR_BANNER_MS);
  }

  function reportActionError(err: unknown) {
    // Auto-fire (Peel/Plantains) rejections — bad words, an incomplete/disconnected grid —
    // are a normal part of building a board and not a real error; the player just keeps
    // adjusting tiles. Surfacing a banner for every rejected auto-attempt was noisy and
    // read as a scary error message for what's actually silent, expected feedback (the
    // tile-color validation already shows which words are wrong).
    //
    // But "expected rejection" and "the server is unreachable / the room is gone" used to be
    // equally silent, because BOTH arrive as an ApiError. That made a genuinely broken game
    // indistinguishable from an unfinished word: the board just sat there forever with no
    // explanation. Only the grid-shaped rejections stay quiet now; anything else says so.
    if (err instanceof ApiError && SILENT_ACTION_ERRORS.has(err.message)) return;
    const text =
      err instanceof ApiError
        ? `Couldn't reach the game (${err.message}). Your tiles are safe — try moving one.`
        : "Couldn't reach the game. Your tiles are safe — check your connection.";
    showError(text);
  }

  useEffect(() => {
    // The xtina owner must never auto-fire anything. Peel advances the script for the WHOLE room
    // regardless of who called it, and her five X/Z tiles laid out in a connected line are
    // structurally valid — so (especially with word validation off) idly lining them up would
    // peel the partner's next word into her tray mid-word and jump her hints forward, leaving
    // the word she's actually building unhinted. She still has a real, unwinnable board; it just
    // never triggers a server action.
    if (isXtina && !isXtinaPartner) return;
    const fullRack = [...rack.map((t) => t.letter), ...Object.values(grid)];
    const res = validateStructure(grid, fullRack);
    if (!res.valid) {
      autoSigRef.current = null;
      return;
    }
    // Structural completeness (all tiles placed, connected, no orphans) is instant, but word
    // validity is an async dictionary lookup (the debounced /validate call above, ~350ms+
    // network). Without this gate, auto-Peel/Plantains fired the moment the grid was structurally
    // complete — often before that lookup had even started — so a board full of gibberish would
    // peel/attempt a win with zero word checking. Wait for the check to finish, and require every
    // placed tile to be part of a currently-valid word, before auto-firing.
    //
    // With word validation off, there's no client-side word check to wait for at all — Peel and
    // Plantains still auto-fire on structural completeness alone, and the server's own dictionary
    // check at Plantains time is the only word validation that happens (silently, per
    // reportActionError above).
    if (wordValidationEnabled) {
      if (wordsPending) return;
      const allWordsValid = Object.keys(grid).every((k) => cellIsGood(k));
      if (!allWordsValid) {
        autoSigRef.current = null;
        return;
      }
    }
    // The soft gate. Her rack holds exactly one word's tiles, so a structurally valid grid is
    // nearly always the right word — but it could be the right letters in the wrong place, which
    // would peel the script forward onto a board that no longer matches the picture. Requiring an
    // exact match means a wrong placement simply doesn't advance: no error, no rejected drag, no
    // visible fight with the player.
    if (isXtinaPartner && !xtinaGridMatches(grid, xtinaStep)) {
      autoSigRef.current = null;
      return;
    }
    const sig = Object.keys(grid)
      .sort()
      .map((k) => `${k}:${grid[k]}`)
      .join('|');
    if (autoSigRef.current === sig) return; // already attempted this exact complete grid
    autoSigRef.current = sig;
    runAutoAction();
  }, [
    grid,
    rack,
    runAutoAction,
    wordsPending,
    cellIsGood,
    wordValidationEnabled,
    isXtina,
    isXtinaPartner,
    xtinaStep,
  ]);

  // --- Dump (still a deliberate action on a selected tray tile) ---------------

  async function handleDump() {
    // Share the same in-flight guard as runAutoAction — both mutate rack/grid/bunchCount from
    // a server response, so letting them overlap risks one clobbering the other's update.
    if (!roomId || !selectedId || busyRef.current) return;
    const tile = rack.find((t) => t.id === selectedId);
    if (!tile) return;
    busyRef.current = true;
    setMessage(null);
    const priorRack = [...rack.map((t) => t.letter), ...Object.values(grid)];
    try {
      const result = await api.dump(roomId, tile.letter);
      moveTracker.recordDump(tile.letter);
      const newLetters = diffNewLetters(priorRack, result.rack);
      setRack(computeUnplaced(result.rack, grid, newLetters, rack));
      setBunchCount(result.bunchCount);
      setSelectedId(null);
      fireCallout('DUMP!');
    } catch (err) {
      setMessage(err instanceof ApiError ? `Dump failed: ${err.message}` : 'Dump failed');
    } finally {
      busyRef.current = false;
    }
  }

  /** Pull every placed tile that isn't part of a valid word back into the tray. */
  function handleRecallInvalid() {
    // cellIsGood, not validCells — otherwise this button rips the xtina partner's scripted
    // accent words (YOURE/MY/LOVE) straight back off the board, since they're not dictionary words.
    const toRecall = Object.keys(grid).filter((k) => !cellIsGood(k));
    if (toRecall.length === 0) return;
    const recalledTiles = toRecall.map((k) => newRackTile(grid[k]));
    setGrid((g) => {
      const next = { ...g };
      for (const k of toRecall) delete next[k];
      return next;
    });
    setRack((r) => [...r, ...recalledTiles]);
    setSelectedId(null);
  }

  // Every non-spectator, self first — replaces the old opponents-only list so the local player
  // sees their own progress alongside everyone else's, not just opponents'.
  const activePlayers = [...players.filter((p) => !p.is_spectator)].sort((a, b) =>
    a.profile_id === profileId ? -1 : b.profile_id === profileId ? 1 : 0,
  );
  const items = trayItems(rack, collapsed, pendingReveal);

  const isSolo = room?.mode === 'solo';

  async function handleLeave() {
    if (!roomId) return;
    const confirmMsg = isSolo
      ? "Leave this game? Your progress won't be saved."
      : 'Leave this game? Your tiles go back into the Bunch.';
    if (!window.confirm(confirmMsg)) return;
    try {
      await api.leaveRoom(roomId);
    } catch {
      // Even if the server call fails (e.g. already removed), still exit the screen.
    }
    navigate('/', { replace: true });
  }

  const lastPeelName =
    lastPeelBy === null
      ? null
      : lastPeelBy === profileId
        ? 'You'
        : (players.find((p) => p.profile_id === lastPeelBy)?.display_name ?? 'Someone');

  return (
    <div className="game-layout">
      <div className="game-topbar">
        {room && (
          <BunchGraphic
            ref={plantainCutRef}
            bunchCount={bunchCount}
            startingBunchCount={startingBunchCount}
            flashSignal={flashSignal}
          />
        )}
        <span className="last-peel-pill">
          Last peel: <strong>{lastPeelName ?? '-'}</strong>
        </span>
        {isTimed && (
          <span className="elapsed-time-pill">{formatElapsed(elapsedMs)}</span>
        )}
        {activePlayers.length > 0 && (
          <div className="player-pills">
            {activePlayers.map((p) => {
              const isSelf = p.profile_id === profileId;
              // Self uses the live local count (no debounce lag on your own number); everyone
              // else uses what THEY last reported, falling back to the raw inventory size
              // (tile_count) until their client reports at least once this game.
              const count = isSelf ? remainingCount : (p.remaining_count ?? p.tile_count);
              return (
                <span key={p.profile_id} className={`player-pill${isSelf ? ' player-pill-self' : ''}`}>
                  {isSelf ? 'You' : p.display_name}: {count}
                  {!p.connected ? ' (disconnected)' : ''}
                </span>
              );
            })}
          </div>
        )}
        <div className="game-actions">
          {!isXtina && (
            <span className="tray-tool-group">
              <button className="btn-tertiary" disabled={!selectedId} onClick={handleDump}>
                Dump!
              </button>
              <InfoTooltip text="Select a tile in your tray first. Dump returns it to the Bunch face-down and draws you 3 new tiles in exchange." />
            </span>
          )}
          <button type="button" className="btn-leave" onClick={handleLeave}>
            Leave
          </button>
        </div>
      </div>

      {/* Overlays the board — see .game-message. Deliberately NOT in the layout flow: as an
          in-flow element it shoved the board and tray down whenever a message appeared. */}
      {message && (
        <p className={`game-message${messageIsError ? ' error' : ''}`} role="status">
          {message}
        </p>
      )}

      <div className="board-area">
        <GameBoard
          ref={viewportRef}
          grid={grid}
          pan={pan}
          zoom={zoom}
          validCells={validCells}
          hintCells={xtinaHints}
          accentCells={xtinaAccents}
          hiddenKey={null}
          selectedKeys={selectedKeys}
          selectionOffset={selectionOffset}
          marquee={marquee}
          mode={boardMode}
          onTilePointerDown={onBoardTilePointerDown}
          onBackgroundPointerDown={onBackgroundPointerDown}
          onViewportPointerDownCapture={onViewportPointerDownCapture}
        />
        <div className="zoom-controls">
          <button
            type="button"
            className={`zoom-btn mode-btn${boardMode === 'select' ? ' active' : ''}`}
            aria-pressed={boardMode === 'select'}
            aria-label={boardMode === 'select' ? 'Switch to move mode' : 'Switch to select mode'}
            title={
              boardMode === 'select'
                ? 'Select mode: drag a box to select tiles, then drag them together. Tap to switch back to moving the board.'
                : 'Move mode: drag to move the board around. Tap to switch to selecting tiles.'
            }
            onClick={() => {
              // Leaving select mode drops any selection — it has no meaning in move mode, and
              // leaving tiles visibly highlighted with no way to act on them reads as a bug.
              if (boardMode === 'select') setSelectedKeys(new Set());
              setBoardMode(boardMode === 'select' ? 'navigate' : 'select');
            }}
          >
            <BoardModeIcon mode={boardMode} />
            {/* title never fires on touch, and unlike zoom's +/- this icon isn't a universal
                symbol — a player has no way to discover what it does without this label. */}
            <span className="zoom-btn-label">{boardMode === 'select' ? 'Select' : 'Move'}</span>
          </button>
          <button type="button" className="zoom-btn" onClick={() => handleZoomButton(1)} aria-label="Zoom in" title="Zoom in">
            <ZoomIcon mode="in" />
            <span className="zoom-btn-label">Zoom in</span>
          </button>
          <button type="button" className="zoom-btn" onClick={() => handleZoomButton(-1)} aria-label="Zoom out" title="Zoom out">
            <ZoomIcon mode="out" />
            <span className="zoom-btn-label">Zoom out</span>
          </button>
        </div>
        {xtinaFinished && (
          <button
            type="button"
            className="btn-primary xtina-view-board"
            onClick={() => navigate(`/room/${roomId}/boards`)}
          >
            View the board
          </button>
        )}
      </div>

      {callout && (
        <div className="callout-layer">
          <BigCallout text={callout} />
        </div>
      )}

      <Tray
        items={items}
        selectedId={selectedId}
        collapsed={collapsed}
        draggingId={draggingId}
        canRecall={invalidPlacedCount > 0}
        pendingIds={pendingReveal}
        sliceRevealedIds={sliceRevealed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
        onRecallInvalid={handleRecallInvalid}
        onTilePointerDown={onTrayPointerDown}
      />

      <SliceFlyLayer ref={sliceRef} />

      {ghost && <DragGhost letter={ghost.letter} x={pointer.x} y={pointer.y} />}
    </div>
  );
}
