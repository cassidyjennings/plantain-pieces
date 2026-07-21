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
  /** Tile ids just unhidden by a landed slice — these get a soft settle instead of the classic
   * drop-in pop, since the slice already carried their letter in on its roll. */
  sliceRevealedIds: Set<string>;
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
  sliceRevealedIds,
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
          const sliceLanded = sliceRevealedIds.has(item.id);
          let revealClass = '';
          if (item.justDrawn && !pending) {
            // The rolling slice already showed this tile's letter, so its reveal is a quick
            // settle, not the classic drop-in pop — that pop is reserved for tiles that never had
            // a slice to carry the motion (collapsed duplicates, reduced motion).
            revealClass = sliceLanded ? ' slice-landed' : ' just-drawn';
          }
          return (
            <button
              key={item.id}
              type="button"
              data-tile-id={item.id}
              data-letter={item.letter}
              className={`tile-chip${item.id === selectedId ? ' selected' : ''}${revealClass}${
                pending ? ' pending' : ''
              }${item.id === draggingId ? ' dragging' : ''}`}
              onPointerDown={(e) => onTilePointerDown(item.id, e)}
            >
              {item.letter}
              {item.count > 1 && <span className="tile-count">{item.count}</span>}
            </button>
          );
        })}
        {items.length === 0 && <p className="hint">All tiles placed. Nice.</p>}
      </div>
    </div>
  );
}
