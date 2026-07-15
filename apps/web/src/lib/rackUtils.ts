import { letterMultiset, type GridState, type Letter } from '@plantain/shared';

export interface RackTile {
  id: string;
  letter: Letter;
  justDrawn?: boolean;
}

let nextId = 0;
function freshId(): string {
  nextId += 1;
  return `t${nextId}-${Date.now()}`;
}

/** The tiles a player still holds in hand: their full inventory minus what's on the grid.
 * `justDrawnLetters`, if given, flags that many tiles per letter as newly drawn (for the
 * slice-fly/tile-drop reveal) — consumed one at a time as matching tiles are built.
 *
 * `prevTiles`, if given, lets tiles that persist across this recompute keep their existing id
 * instead of getting a fresh one. Every tile object here used to be rebuilt from scratch on every
 * call (even ones with no new draw involved, e.g. after a Dump only 2-3 tiles are actually new),
 * which meant React unmounted and remounted the *entire* tray on every single draw — a lot of
 * unnecessary DOM churn that also risked transient rendering artifacts around the tiles that
 * genuinely were mid reveal-animation. Reusing ids keeps identity stable for anything that isn't
 * actually new. */
export function computeUnplaced(
  fullRack: Letter[],
  grid: GridState,
  justDrawnLetters: Letter[] = [],
  prevTiles: RackTile[] = [],
): RackTile[] {
  const remaining = letterMultiset(fullRack);
  for (const letter of Object.values(grid)) {
    remaining[letter] = (remaining[letter] ?? 0) - 1;
  }
  const justDrawnCounts = letterMultiset(justDrawnLetters);

  const prevByLetter = new Map<Letter, RackTile[]>();
  for (const t of prevTiles) {
    if (!prevByLetter.has(t.letter)) prevByLetter.set(t.letter, []);
    prevByLetter.get(t.letter)!.push(t);
  }

  const tiles: RackTile[] = [];
  for (const [letter, count] of Object.entries(remaining)) {
    const pool = prevByLetter.get(letter);
    for (let i = 0; i < count; i++) {
      const justDrawn = (justDrawnCounts[letter] ?? 0) > 0;
      if (justDrawn) {
        // A genuinely new draw always gets a fresh id/element, even if the letter matches a tile
        // already in hand — it needs its own identity for the reveal animation to target.
        justDrawnCounts[letter] -= 1;
        tiles.push({ id: freshId(), letter, justDrawn: true });
      } else if (pool && pool.length > 0) {
        tiles.push({ id: pool.shift()!.id, letter, justDrawn: false });
      } else {
        tiles.push({ id: freshId(), letter, justDrawn: false });
      }
    }
  }
  return tiles;
}

export function newRackTile(letter: Letter): RackTile {
  return { id: freshId(), letter };
}

/** A displayed tray item: one tile (expanded) or a whole letter-group (collapsed). */
export interface TrayItem {
  /** The rack tile id that a drag on this item picks up (first of the group when collapsed). */
  id: string;
  letter: Letter;
  count: number;
  justDrawn: boolean;
  /** All rack tile ids in this group (length 1 when expanded). */
  ids: string[];
}

/** Build the tray's display items. Collapsed groups duplicates by first-occurrence order. */
export function trayItems(rack: RackTile[], collapsed: boolean): TrayItem[] {
  if (!collapsed) {
    return rack.map((t) => ({ id: t.id, letter: t.letter, count: 1, justDrawn: !!t.justDrawn, ids: [t.id] }));
  }
  const order: Letter[] = [];
  const groups = new Map<Letter, RackTile[]>();
  for (const t of rack) {
    if (!groups.has(t.letter)) {
      groups.set(t.letter, []);
      order.push(t.letter);
    }
    groups.get(t.letter)!.push(t);
  }
  return order.map((letter) => {
    const tiles = groups.get(letter)!;
    return {
      id: tiles[0].id,
      letter,
      count: tiles.length,
      justDrawn: tiles.some((t) => t.justDrawn),
      ids: tiles.map((t) => t.id),
    };
  });
}

/** Insert a tile into the rack at a display index (clamped). */
export function insertRackTile(rack: RackTile[], tile: RackTile, index: number): RackTile[] {
  const next = [...rack];
  const i = Math.max(0, Math.min(index, next.length));
  next.splice(i, 0, tile);
  return next;
}

/** Move a single tile (by id) to a new position in the rack — expanded-mode reorder. */
export function moveRackTile(rack: RackTile[], id: string, toIndex: number): RackTile[] {
  const from = rack.findIndex((t) => t.id === id);
  if (from === -1) return rack;
  const next = [...rack];
  const [tile] = next.splice(from, 1);
  const i = Math.max(0, Math.min(toIndex, next.length));
  next.splice(i, 0, tile);
  return next;
}

/** Move a whole letter-group to a new group position — collapsed-mode reorder. */
export function moveRackLetterGroup(rack: RackTile[], letter: Letter, toGroupIndex: number): RackTile[] {
  const items = trayItems(rack, true);
  const fromGroup = items.findIndex((it) => it.letter === letter);
  if (fromGroup === -1) return rack;
  const order = items.map((it) => it.letter);
  order.splice(fromGroup, 1);
  const i = Math.max(0, Math.min(toGroupIndex, order.length));
  order.splice(i, 0, letter);
  // Rebuild rack by the new group order, preserving each tile's object.
  const byLetter = new Map<Letter, RackTile[]>();
  for (const t of rack) {
    if (!byLetter.has(t.letter)) byLetter.set(t.letter, []);
    byLetter.get(t.letter)!.push(t);
  }
  return order.flatMap((l) => byLetter.get(l) ?? []);
}

/** Letters present in `after` more times than in `before` — i.e. what was newly drawn. */
export function diffNewLetters(before: Letter[], after: Letter[]): Letter[] {
  const beforeCounts = letterMultiset(before);
  const added: Letter[] = [];
  for (const letter of after) {
    if ((beforeCounts[letter] ?? 0) > 0) {
      beforeCounts[letter] -= 1;
    } else {
      added.push(letter);
    }
  }
  return added;
}
