import { useCallback, useEffect, useRef } from 'react';
import { newlyFoundEggs, type EggWord } from '@plantain/shared';

/** Runs when its egg first appears validly on the board. Resolving to `false` (or throwing)
 * re-arms it, so it fires again the next time the board changes while the word is still up. */
export type EggTrigger = () => void | boolean | Promise<void | boolean>;
export type EggTriggers = Partial<Record<EggWord, EggTrigger>>;

/**
 * Watches the set of egg words currently validly on the local board and fires each egg's trigger
 * once per game. Game.tsx remounts per room, so "per game" is simply "per mount" — the refs below
 * reset on their own for a rematch.
 *
 * `found` is sticky and separate from `fired`: an egg counts as found the moment it first appears,
 * even if its trigger later re-arms or the word is broken — that's what the end-of-game summary
 * reports (eggs_found) and what GHOST's "even if you later break the word" relies on.
 */
export function useEasterEggs(
  eggsOnBoard: ReadonlySet<string>,
  triggers: EggTriggers,
): { getFoundEggs: () => EggWord[] } {
  const firedRef = useRef<Set<EggWord>>(new Set());
  const foundRef = useRef<Set<EggWord>>(new Set());
  // Latest handlers without making them effect dependencies: Game rebuilds them every render.
  const triggersRef = useRef(triggers);
  triggersRef.current = triggers;

  useEffect(() => {
    const fresh = newlyFoundEggs(eggsOnBoard, firedRef.current);
    for (const egg of fresh) {
      firedRef.current.add(egg);
      foundRef.current.add(egg);
      const trigger = triggersRef.current[egg];
      if (!trigger) continue;
      Promise.resolve()
        .then(trigger)
        .then((ok) => {
          if (ok === false) firedRef.current.delete(egg);
        })
        .catch(() => firedRef.current.delete(egg));
    }
  }, [eggsOnBoard]);

  const getFoundEggs = useCallback(() => [...foundRef.current], []);
  return { getFoundEggs };
}
