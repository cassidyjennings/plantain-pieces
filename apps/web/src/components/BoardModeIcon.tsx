import type { BoardMode } from '../store/settingsStore.js';

interface Props {
  mode: BoardMode;
}

/**
 * The board's drag-mode toggle icon. Shows the mode you're currently IN (matching the
 * aria-pressed state), not the one you'd switch to — a toggle that displays its own state is
 * easier to read at a glance than one that displays its action.
 *
 * navigate: a four-way move arrow — drag to move the board around.
 * select:   a dashed marquee box with a tile inside — drag a box to select tiles.
 */
export default function BoardModeIcon({ mode }: Props) {
  if (mode === 'select') {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
        <rect
          x="2.5"
          y="2.5"
          width="19"
          height="19"
          rx="2.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="3.6 2.8"
        />
        <rect x="8" y="8" width="8" height="8" rx="1.5" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
      <line x1="12" y1="3.2" x2="12" y2="20.8" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
      <line x1="3.2" y1="12" x2="20.8" y2="12" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
      <path
        d="M12 2.2 14.6 5.6 H9.4 Z M12 21.8 14.6 18.4 H9.4 Z M2.2 12 5.6 9.4 V14.6 Z M21.8 12 18.4 9.4 V14.6 Z"
        fill="currentColor"
      />
    </svg>
  );
}
