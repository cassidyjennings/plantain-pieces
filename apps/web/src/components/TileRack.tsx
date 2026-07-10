import type { RackTile } from '../lib/rackUtils.js';

interface Props {
  tiles: RackTile[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function TileRack({ tiles, selectedId, onSelect }: Props) {
  return (
    <div className="tile-rack">
      {tiles.map((t) => (
        <button
          key={t.id}
          className={`tile-chip${t.id === selectedId ? ' selected' : ''}`}
          onClick={() => onSelect(t.id)}
        >
          {t.letter}
        </button>
      ))}
      {tiles.length === 0 && <p className="hint">All tiles placed.</p>}
    </div>
  );
}
