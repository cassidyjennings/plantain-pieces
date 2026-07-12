import { GRID_SIZE } from '@plantain/shared';

/** Board cell size in world px. Tiles fill a cell; snapping is per-cell. */
export const CELL = 40;

/** Full board extent in world px (before pan/zoom). */
export const WORLD = GRID_SIZE * CELL;
