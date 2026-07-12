interface Props {
  mode: 'in' | 'out';
}

/** A bold magnifying-glass glyph with a +/- inside the lens, matching the classic
 * zoom-in/zoom-out icon pairing (thick ring + handle, thin cross/bar centered in the lens). */
export default function ZoomIcon({ mode }: Props) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="2.75" />
      <line x1="20.3" y1="20.3" x2="15.3" y2="15.3" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" />
      {mode === 'in' && (
        <line x1="10" y1="6.25" x2="10" y2="13.75" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
      )}
      <line x1="6.25" y1="10" x2="13.75" y2="10" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
    </svg>
  );
}
