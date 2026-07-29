import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { parseKey, type GridState } from '@plantain/shared';
import { CELL } from '../lib/board.js';

interface Props {
  grid: GridState;
  /** Cell keys belonging to a dictionary-valid word — tinted green, same cue as in-game. */
  validCells?: Set<string>;
  /** Never scale past this. A six-tile board blown up to fill a screen reads as broken, not
   * impressive, so the default is 1 (never larger than the real in-game tile size). */
  maxScale?: number;
  /** Describes whose board this is, for screen readers — the tiles themselves are a visual
   * rendering of information also available as text in the word list. */
  label?: string;
  emptyMessage?: string;
}

/**
 * Read-only, auto-fitting render of a finished board.
 *
 * Deliberately NOT a reuse of GameBoard: that component is built around the drag orchestration
 * in Game.tsx (pan/zoom state, pointer-down handlers per tile, a hidden-key for the tile
 * currently lifted). None of it applies to a board nobody can touch, and threading a "disabled"
 * flag through all of it would make both components harder to follow than two small ones.
 *
 * Only occupied cells are rendered — the world is 50x50 (2500 cells) but a finished board is
 * typically a few dozen tiles, so rendering the full grid would be ~100x the DOM for no gain.
 */
export default function BoardPreview({
  grid,
  validCells,
  maxScale = 1,
  label,
  emptyMessage = 'Board not available',
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  // Bounding box of the occupied cells, so the board is framed to what was actually built
  // rather than to the (mostly empty) 50x50 world.
  const box = useMemo(() => {
    const keys = Object.keys(grid);
    if (keys.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const key of keys) {
      const { x, y } = parseKey(key);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return {
      minX,
      minY,
      width: (maxX - minX + 1) * CELL,
      height: (maxY - minY + 1) * CELL,
    };
  }, [grid]);

  // Fit the board to whatever space the host element ends up with. A ResizeObserver (rather
  // than a one-shot measurement) is what keeps this correct through an orientation change, a
  // window resize, or the surrounding layout settling after fonts load.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !box) return;
    const fit = () => {
      const { width, height } = host.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      setScale(Math.min(width / box.width, height / box.height, maxScale));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    return () => observer.disconnect();
  }, [box, maxScale]);

  if (!box) {
    return (
      <div className="board-preview board-preview-empty" ref={hostRef}>
        <p className="hint">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="board-preview" ref={hostRef} role="img" aria-label={label}>
      <div
        className="board-preview-world"
        style={{
          width: box.width,
          height: box.height,
          // Centered via a -50% translate, then scaled from the middle. transform only — no
          // width/height animation — so a resize stays a cheap composite.
          transform: `translate(-50%, -50%) scale(${scale})`,
          // Hidden until measured, so the board never flashes at the wrong size on first paint.
          visibility: scale > 0 ? 'visible' : 'hidden',
        }}
      >
        {Object.entries(grid).map(([key, letter]) => {
          const { x, y } = parseKey(key);
          return (
            <div
              key={key}
              className={`board-tile${validCells?.has(key) ? ' valid' : ''}`}
              style={{
                left: (x - box.minX) * CELL,
                top: (y - box.minY) * CELL,
                width: CELL,
                height: CELL,
              }}
            >
              {letter}
            </div>
          );
        })}
      </div>
    </div>
  );
}
