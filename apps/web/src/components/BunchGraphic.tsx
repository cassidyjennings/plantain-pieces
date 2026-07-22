import { forwardRef } from 'react';
import { TOTAL_TILES } from '@plantain/shared';
import BunchPlantain from './BunchPlantain.js';

interface Props {
  bunchCount: number;
  /** The Bunch's own starting size (144 for multiplayer/full solo, or a solo player's smaller
   * chosen size) — the denominator the meter fills against, so a smaller Bunch always starts
   * looking whole and just empties faster, instead of starting already partly cut. */
  startingBunchCount?: number;
  /** Bumped on each draw to fire the cut flash on the plantain. */
  flashSignal: number;
}

/** The Bunch meter: a long side-plantain that shrinks as tiles are drawn, plus a live count.
 * Forwards a ref to the plantain's cut-end anchor so the slice-fly animation knows where to
 * launch each flying slice from. */
const BunchGraphic = forwardRef<HTMLSpanElement, Props>(function BunchGraphic(
  { bunchCount, startingBunchCount = TOTAL_TILES, flashSignal },
  cutRef,
) {
  const fraction = Math.max(0, Math.min(1, bunchCount / startingBunchCount));
  return (
    <div className="bunch-status">
      <BunchPlantain ref={cutRef} fraction={fraction} flashSignal={flashSignal} />
      <span className="bunch-label">{bunchCount} left in Bunch</span>
    </div>
  );
});

export default BunchGraphic;
