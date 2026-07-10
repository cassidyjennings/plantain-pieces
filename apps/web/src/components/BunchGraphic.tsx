import { TOTAL_TILES } from '@plantain/shared';

export default function BunchGraphic({ bunchCount }: { bunchCount: number }) {
  const fraction = Math.max(0, Math.min(1, bunchCount / TOTAL_TILES));
  return (
    <div className="bunch">
      <div className="bunch-emoji" style={{ transform: `scale(${0.5 + 0.5 * fraction})` }}>
        🍌
      </div>
      <div className="bunch-bar">
        <div className="bunch-bar-fill" style={{ width: `${fraction * 100}%` }} />
      </div>
      <span>{bunchCount} tiles left in the Bunch</span>
    </div>
  );
}
