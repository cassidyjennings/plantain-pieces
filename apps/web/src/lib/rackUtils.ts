import { letterMultiset, type GridState, type Letter } from '@plantain/shared';

export interface RackTile {
  id: string;
  letter: Letter;
}

let nextId = 0;
function freshId(): string {
  nextId += 1;
  return `t${nextId}-${Date.now()}`;
}

/** The tiles a player still holds in hand: their full inventory minus what's on the grid. */
export function computeUnplaced(fullRack: Letter[], grid: GridState): RackTile[] {
  const remaining = letterMultiset(fullRack);
  for (const letter of Object.values(grid)) {
    remaining[letter] = (remaining[letter] ?? 0) - 1;
  }
  const tiles: RackTile[] = [];
  for (const [letter, count] of Object.entries(remaining)) {
    for (let i = 0; i < count; i++) tiles.push({ id: freshId(), letter });
  }
  return tiles;
}

export function newRackTile(letter: Letter): RackTile {
  return { id: freshId(), letter };
}
