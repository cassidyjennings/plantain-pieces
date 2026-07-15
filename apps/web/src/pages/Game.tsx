import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  extractWordsWithCells,
  makeKey,
  validateStructure,
  type GridState,
} from '@plantain/shared';
import { api, ApiError } from '../lib/api.js';
import { fetchPlayers, fetchRoom, type PublicPlayer } from '../lib/rooms.js';
import { useRoomEvents } from '../hooks/useRoomEvents.js';
import { useSessionStore } from '../store/sessionStore.js';
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
import SliceFlyLayer, { type SliceFlyHandle } from '../components/SliceFlyLayer.js';

const CALLOUT_MS = 900;
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
    };

export default function Game() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const profileId = useSessionStore((s) => s.profileId);

  const [grid, setGrid] = useState<GridState>({});
  const [rack, setRack] = useState<RackTile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [bunchCount, setBunchCount] = useState(144);
  const [players, setPlayers] = useState<PublicPlayer[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [callout, setCallout] = useState<string | null>(null);
  const [validCells, setValidCells] = useState<Set<string>>(new Set());
  const [wordsPending, setWordsPending] = useState(false);
  // Slice-fly animation: chips waiting for their flying slice to land, chips that were just
  // revealed by a landed slice (so they get a soft settle instead of the drop-in pop — the slice
  // rolling in with the letter already visible *is* their reveal), and a counter that pulses the
  // plantain's cut-flash on each draw.
  const [pendingReveal, setPendingReveal] = useState<Set<string>>(new Set());
  const [sliceRevealed, setSliceRevealed] = useState<Set<string>>(new Set());
  const [flashSignal, setFlashSignal] = useState(0);

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
  // Slice-fly wiring: the plantain cut-end anchor (slice origin), the animation layer handle, and
  // the set of tile ids we've already launched a slice for (so re-renders don't re-fire).
  const plantainCutRef = useRef<HTMLSpanElement>(null);
  const sliceRef = useRef<SliceFlyHandle>(null);
  const animatedIds = useRef<Set<string>>(new Set());

  // Mirror the latest values into refs so the window pointer handlers (attached once) read fresh.
  const gridRef = useRef(grid);
  const rackRef = useRef(rack);
  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  const collapsedRef = useRef(collapsed);
  const playersRef = useRef(players);
  const bunchRef = useRef(bunchCount);
  gridRef.current = grid;
  rackRef.current = rack;
  panRef.current = pan;
  zoomRef.current = zoom;
  collapsedRef.current = collapsed;
  playersRef.current = players;
  bunchRef.current = bunchCount;

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

    // In expanded mode each fresh tile has its own chip we can hide until its slice lands. In
    // collapsed mode duplicates share one chip (no per-tile slot), so we skip the hide/reveal and
    // let the slice land as a flourish on the group chip instead.
    if (!collapsed && !reduce) {
      setPendingReveal((prev) => {
        const next = new Set(prev);
        fresh.forEach((t) => next.add(t.id));
        return next;
      });
    }
    setFlashSignal((s) => s + 1);

    sliceRef.current?.launch({
      from: () => plantainCutRef.current?.getBoundingClientRect() ?? null,
      to: (i) => {
        const t = fresh[i];
        const selector = collapsed ? `[data-letter="${t.letter}"]` : `[data-tile-id="${t.id}"]`;
        const el = document.querySelector(selector);
        return el ? el.getBoundingClientRect() : null;
      },
      letters: fresh.map((t) => t.letter),
      count: fresh.length,
      staggerMs: fresh.length > 1 ? 180 : 0,
      onLanded: (i) => revealChip(fresh[i].id),
    });
  }, [rack, collapsed, revealChip]);

  const loadState = useCallback(async () => {
    if (!roomId) return;
    const [state, room, playerList] = await Promise.all([
      api.getMyState(roomId),
      fetchRoom(roomId),
      fetchPlayers(roomId),
    ]);
    setGrid(state.grid);
    setRack(computeUnplaced(state.rack, state.grid));
    setPlayers(playerList);
    if (room) setBunchCount(room.bunch_count);
  }, [roomId]);

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

  useRoomEvents(roomId, (event) => {
    if (event.type === 'game_over') {
      navigate(`/room/${roomId}/results`, { replace: true });
      return;
    }
    if (event.type === 'peel' || event.type === 'dump' || event.type === 'game_started') {
      const payload = event.payload as { bunchCount?: number };
      if (typeof payload.bunchCount === 'number') setBunchCount(payload.bunchCount);
      if (roomId) fetchPlayers(roomId).then(setPlayers);
    }
    if (event.type === 'plantains_rejected') {
      const payload = event.payload as { actor: string; reason: string };
      if (payload.actor !== profileId) {
        setMessage(`Someone's Plantains! call was rejected (${payload.reason}) — keep playing.`);
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

  const handleMove = useCallback((e: globalThis.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'pan') {
      setPan({
        x: Math.round(d.startPan.x + (e.clientX - d.startX)),
        y: Math.round(d.startPan.y + (e.clientY - d.startY)),
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
  }, []);

  const handleUp = useCallback(
    (e: globalThis.PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setGhost(null);
      setDraggingId(null);
      if (!d || d.kind === 'pan') return;

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

  useEffect(() => {
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [handleMove, handleUp]);

  function onTrayPointerDown(id: string, e: PointerEvent) {
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
    const letter = grid[key];
    if (!letter) return;
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
        const cells = new Set<string>();
        for (const w of words) {
          if (!invalid.has(w.word)) for (const c of w.cells) cells.add(c);
        }
        setValidCells(cells);
      } catch {
        /* transient — leave previous highlight */
      } finally {
        setWordsPending(false);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [grid, roomId]);

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
        fireCallout('PLANTAINS!');
        setTimeout(() => navigate(`/room/${roomId}/results`, { replace: true }), CALLOUT_MS);
      }
    } catch (err) {
      if (err instanceof ApiError && err.message === 'BUNCH_TOO_LOW') {
        // Someone peeled the Bunch dry between our check and call — go for the win instead.
        try {
          await api.plantains(roomId, submittedGrid);
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
  }, [roomId, navigate]);

  function reportActionError(err: unknown) {
    if (err instanceof ApiError) {
      const invalidWords = (err.body as { invalidWords?: string[] }).invalidWords;
      setMessage(
        invalidWords?.length
          ? `Rotten Plantains! Not real words: ${invalidWords.join(', ')}`
          : err.message === 'INVALID_WORDS'
            ? 'Rotten Plantains! Some words are not valid.'
            : `That grid isn't complete yet (${err.message}).`,
      );
    } else {
      setMessage('Action failed — try again.');
    }
  }

  useEffect(() => {
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
    if (wordsPending) return;
    const allWordsValid = Object.keys(grid).every((k) => validCells.has(k));
    if (!allWordsValid) {
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
  }, [grid, rack, runAutoAction, wordsPending, validCells]);

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
    const toRecall = Object.keys(grid).filter((k) => !validCells.has(k));
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

  const opponents = players.filter((p) => p.profile_id !== profileId && !p.is_spectator);
  const items = trayItems(rack, collapsed);
  const invalidPlacedCount = Object.keys(grid).filter((k) => !validCells.has(k)).length;

  return (
    <div className="game-layout">
      <div className="game-topbar">
        <BunchGraphic ref={plantainCutRef} bunchCount={bunchCount} flashSignal={flashSignal} />
        <div className="opponent-pills">
          {opponents.map((p) => (
            <span key={p.profile_id} className="opponent-pill">
              {p.display_name}: {p.tile_count} 🍃{!p.connected ? ' (disconnected)' : ''}
            </span>
          ))}
        </div>
        <div className="game-actions">
          <span className="tray-tool-group">
            <button className="btn-tertiary" disabled={!selectedId} onClick={handleDump}>
              Dump!
            </button>
            <InfoTooltip text="Select a tile in your tray first. Dump returns it to the Bunch face-down and draws you 3 new tiles in exchange." />
          </span>
        </div>
      </div>

      {message && <p className="game-message">{message}</p>}

      <div className="board-area">
        <GameBoard
          ref={viewportRef}
          grid={grid}
          pan={pan}
          zoom={zoom}
          validCells={validCells}
          hiddenKey={null}
          onTilePointerDown={onBoardTilePointerDown}
          onBackgroundPointerDown={onBackgroundPointerDown}
        />
        <div className="zoom-controls">
          <button type="button" className="zoom-btn" onClick={() => handleZoomButton(1)} aria-label="Zoom in" title="Zoom in">
            <ZoomIcon mode="in" />
          </button>
          <button type="button" className="zoom-btn" onClick={() => handleZoomButton(-1)} aria-label="Zoom out" title="Zoom out">
            <ZoomIcon mode="out" />
          </button>
        </div>
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
