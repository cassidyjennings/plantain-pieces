import { useEffect, useRef } from 'react';
import {
  extractWords,
  computeMoveStats,
  type GridState,
  type GameSummary,
} from '@plantain/shared';

interface RackLike {
  id: string;
  letter: string;
  justDrawn?: boolean;
}

interface TrackerState {
  moveIndex: number;
  prevGridSize: number;
  prevRackIds: Set<string>;
  drawTimes: Map<string, number>;
  lifecycles: { drawnAtMove: number; placedAtMove: number | null }[];
  dumpedLetters: string[];
}

/**
 * Lightweight, self-contained per-game move tracker for the client end-of-game summary. It
 * observes grid/rack changes rather than hooking the drag internals, so it stays decoupled
 * from the (complex) board interaction code. The numbers are casual/approximate by design —
 * the server stores them with only loose validation.
 *
 * - A "move" = a tile landing on the board (grid size increases).
 * - drawnAtMove: the move index when a tile was drawn (Peel/Dump-produced, i.e. justDrawn);
 *   initial-deal tiles default to 0 (available from the start).
 * - placedAtMove: the move index when the tile left the rack onto the board.
 * These feed peel-efficiency (avg wait) and idle-tile ratio. Dump regret is approximated as
 * dumped letters that ended up in the final grid.
 */
export function useMoveTracker(grid: GridState, rack: RackLike[]) {
  const state = useRef<TrackerState>({
    moveIndex: 0,
    prevGridSize: 0,
    prevRackIds: new Set(),
    drawTimes: new Map(),
    lifecycles: [],
    dumpedLetters: [],
  });

  useEffect(() => {
    const s = state.current;
    const gridSize = Object.keys(grid).length;
    const curIds = new Set(rack.map((t) => t.id));

    // Record draw times for genuinely-drawn tiles the first time we see them.
    for (const t of rack) {
      if (t.justDrawn && !s.drawTimes.has(t.id)) s.drawTimes.set(t.id, s.moveIndex);
    }

    // Tiles that left the rack while the grid grew were placed → one move each.
    const grew = gridSize - s.prevGridSize;
    if (grew > 0) {
      const removed = [...s.prevRackIds].filter((id) => !curIds.has(id));
      for (let i = 0; i < Math.min(grew, removed.length); i++) {
        s.moveIndex += 1;
        s.lifecycles.push({ drawnAtMove: s.drawTimes.get(removed[i]) ?? 0, placedAtMove: s.moveIndex });
      }
    }

    s.prevGridSize = gridSize;
    s.prevRackIds = curIds;
  }, [grid, rack]);

  return {
    /** Call when the player dumps a tile, to feed the dump-regret proxy. */
    recordDump(letter: string) {
      state.current.dumpedLetters.push(letter.toUpperCase());
    },
    /** Build the summary to submit, from the final grid. */
    buildSummary(finalGrid: GridState): GameSummary {
      const s = state.current;
      const words = extractWords(finalGrid);
      const gridLetters = new Set(Object.values(finalGrid).map((l) => l.toUpperCase()));
      const dumps = s.dumpedLetters.map((letter) => ({ regretful: gridLetters.has(letter) }));
      return {
        words,
        placedCount: Object.keys(finalGrid).length,
        moveStats: computeMoveStats({ tiles: s.lifecycles, dumps }),
      };
    },
  };
}
