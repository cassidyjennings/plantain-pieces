import { type PointerEvent } from 'react';
import type { TrayItem } from '../lib/rackUtils.js';
import InfoTooltip from './InfoTooltip.js';

interface Props {
  items: TrayItem[];
  selectedId: string | null;
  collapsed: boolean;
  draggingId: string | null;
  canRecall: boolean;
  /** Tile ids currently hidden while their flying slice is still in transit. */
  pendingIds: Set<string>;
  onToggleCollapse: () => void;
  onRecallInvalid: () => void;
  onTilePointerDown: (id: string, e: PointerEvent) => void;
}

export default function Tray({
  items,
  selectedId,
  collapsed,
  draggingId,
  canRecall,
  pendingIds,
  onToggleCollapse,
  onRecallInvalid,
  onTilePointerDown,
}: Props) {
  return (
    <div className="rack-dock">
      <div className="tray-toolbar">
        <span className="tray-tool-group">
          <button
            type="button"
            className={`tray-tool${collapsed ? ' active' : ''}`}
            onClick={onToggleCollapse}
            aria-pressed={collapsed}
          >
            {collapsed ? '▦ Expand duplicates' : '▤ Collapse duplicates'}
          </button>
          <InfoTooltip
            text={
              collapsed
                ? 'Show every tile in your tray separately again, instead of grouped into piles.'
                : 'Group identical letters in your tray into a single tile with a count badge, so a full hand of tiles takes up less space.'
            }
          />
        </span>
        <span className="tray-tool-group">
          <button type="button" className="tray-tool" onClick={onRecallInvalid} disabled={!canRecall}>
            ↩ Recall invalid
          </button>
          <InfoTooltip text="Return every placed tile that isn't currently part of a valid word back to your tray, leaving valid words on the board." />
        </span>
      </div>

      <div className="tile-rack" data-tray>
        {items.map((item) => {
          const pending = pendingIds.has(item.id);
          return (
            <button
              key={item.id}
              type="button"
              data-tile-id={item.id}
              data-letter={item.letter}
              className={`tile-chip${item.id === selectedId ? ' selected' : ''}${
                // Hold the drop pop until the slice lands; adding the class on reveal restarts it.
                item.justDrawn && !pending ? ' just-drawn' : ''
              }${pending ? ' pending' : ''}${item.id === draggingId ? ' dragging' : ''}`}
              onPointerDown={(e) => onTilePointerDown(item.id, e)}
            >
              {item.letter}
              {item.count > 1 && <span className="tile-count">{item.count}</span>}
            </button>
          );
        })}
        {items.length === 0 && <p className="hint">All tiles placed — nice.</p>}
      </div>
    </div>
  );
}
