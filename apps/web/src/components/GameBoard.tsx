import { forwardRef, type PointerEvent } from 'react';
import { parseKey, type GridState } from '@plantain/shared';
import { CELL, WORLD } from '../lib/board.js';

interface Props {
  grid: GridState;
  pan: { x: number; y: number };
  zoom: number;
  /** Cell keys that belong to at least one valid dictionary word (green tint). */
  validCells: Set<string>;
  /** Cell currently lifted for dragging (hidden from the board). */
  hiddenKey: string | null;
  onTilePointerDown: (key: string, e: PointerEvent) => void;
  onBackgroundPointerDown: (e: PointerEvent) => void;
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
  { grid, pan, zoom, validCells, hiddenKey, onTilePointerDown, onBackgroundPointerDown },
  viewportRef,
) {
  return (
    <div className="board-viewport" ref={viewportRef} onPointerDown={onBackgroundPointerDown}>
      <div
        className="board-world"
        style={{
          width: WORLD,
          height: WORLD,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        {Object.entries(grid).map(([key, letter]) => {
          if (key === hiddenKey) return null;
          const { x, y } = parseKey(key);
          return (
            <div
              key={key}
              className={`board-tile${validCells.has(key) ? ' valid' : ''}`}
              style={{ left: x * CELL, top: y * CELL, width: CELL, height: CELL }}
              onPointerDown={(e) => onTilePointerDown(key, e)}
            >
              {letter}
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default GameBoard;
