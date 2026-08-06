import { forwardRef, type PointerEvent } from 'react';
import { parseKey, type GridState } from '@plantain/shared';
import { CELL, WORLD } from '../lib/board.js';

interface Props {
  grid: GridState;
  pan: { x: number; y: number };
  zoom: number;
  /** Cell keys that belong to at least one valid dictionary word (green tint). */
  validCells: Set<string>;
  /** Empty cells to outline in dotted lines — where the next scripted word goes. Deliberately
   * carries no letters: working the word out from the tiles in the tray is the point. */
  hintCells: Set<string>;
  /** Cells rendered in the accent color instead of the ordinary tile color. Takes precedence
   * over `validCells`, so an accented word never reads as an invalid one. */
  accentCells: Set<string>;
  /** Cell currently lifted for dragging (hidden from the board). */
  hiddenKey: string | null;
  /** Cell keys currently box-selected (select mode only). */
  selectedKeys: Set<string>;
  /** Live whole-cell shift applied to the selected tiles while they're being dragged. Null when
   * no selection move is in flight. */
  selectionOffset: { dx: number; dy: number } | null;
  /** The live selection rectangle, in viewport-relative pixels. Null when not dragging one. */
  marquee: { x: number; y: number; w: number; h: number } | null;
  /** Drives the viewport's cursor via a data attribute — see styles.css. */
  mode: 'navigate' | 'select';
  onTilePointerDown: (key: string, e: PointerEvent) => void;
  onBackgroundPointerDown: (e: PointerEvent) => void;
  /** Capture-phase pointerdown on the viewport itself, ahead of any tile/background bubble
   * handler — see the long comment at its call site in Game.tsx for why this has to be capture,
   * not bubble. */
  onViewportPointerDownCapture: (e: PointerEvent) => void;
}

/**
 * DOM-based board: a pannable/zoomable world of absolutely-positioned tile divs over a
 * CSS grid background. Only occupied cells are rendered, so cost scales with tiles placed,
 * not the full 50x50 grid. Pointer dragging is orchestrated by the parent (Game).
 *
 * Wheel/pinch handling is deliberately NOT wired up here via a React `onWheel` prop — React
 * attaches wheel listeners as passive by default, which silently ignores `preventDefault()` and
 * lets the browser's native pinch/ctrl+wheel zoom the whole page instead of the board. Game.tsx
 * attaches a real `{ passive: false }` listener directly to this div via the forwarded ref.
 */
const GameBoard = forwardRef<HTMLDivElement, Props>(function GameBoard(
  {
    grid,
    pan,
    zoom,
    validCells,
    hintCells,
    accentCells,
    hiddenKey,
    selectedKeys,
    selectionOffset,
    marquee,
    mode,
    onTilePointerDown,
    onBackgroundPointerDown,
    onViewportPointerDownCapture,
  },
  viewportRef,
) {
  return (
    <div
      className="board-viewport"
      data-mode={mode}
      ref={viewportRef}
      onPointerDown={onBackgroundPointerDown}
      onPointerDownCapture={onViewportPointerDownCapture}
    >
      <div
        className="board-world"
        style={{
          width: WORLD,
          height: WORLD,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        {[...hintCells].map((key) => {
          const { x, y } = parseKey(key);
          return (
            <div
              key={`hint-${key}`}
              className="board-hint"
              style={{ left: x * CELL, top: y * CELL, width: CELL, height: CELL }}
            />
          );
        })}

        {Object.entries(grid).map(([key, letter]) => {
          if (key === hiddenKey) return null;
          const { x, y } = parseKey(key);
          const selected = selectedKeys.has(key);
          // Only the selected tiles shift during a selection drag; everything else stays put,
          // so the player can see exactly where the group will land relative to the rest.
          const ox = selected && selectionOffset ? selectionOffset.dx : 0;
          const oy = selected && selectionOffset ? selectionOffset.dy : 0;
          return (
            <div
              key={key}
              className={`board-tile${accentCells.has(key) ? ' accent' : validCells.has(key) ? ' valid' : ''}${selected ? ' selected' : ''}`}
              style={{
                left: (x + ox) * CELL,
                top: (y + oy) * CELL,
                width: CELL,
                height: CELL,
              }}
              onPointerDown={(e) => onTilePointerDown(key, e)}
            >
              {letter}
            </div>
          );
        })}
      </div>

      {/* Sits outside board-world so it isn't scaled by the zoom transform — it's a screen-space
          rectangle following the pointer, not part of the board. */}
      {marquee && (
        <div
          className="board-marquee"
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}
    </div>
  );
});

export default GameBoard;
