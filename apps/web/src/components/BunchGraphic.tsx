import { TOTAL_TILES } from '@plantain/shared';
import PlantainMascot from './PlantainMascot.js';

export default function BunchGraphic({ bunchCount }: { bunchCount: number }) {
  const fraction = Math.max(0, Math.min(1, bunchCount / TOTAL_TILES));
  return (
    <div className="bunch-status">
      <PlantainMascot size={50} fraction={fraction} />
      <div className="bunch-progress-col">
        <div className="bunch-bar">
          <div className="bunch-bar-fill" style={{ width: `${fraction * 100}%` }} />
        </div>
        <span className="bunch-label">{bunchCount} left in Bunch</span>
      </div>
    </div>
  );
}
