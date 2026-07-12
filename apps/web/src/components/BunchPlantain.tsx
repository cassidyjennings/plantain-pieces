import { forwardRef, useEffect, useRef } from 'react';

interface Props {
  /** 0-1 of the Bunch remaining. Drives how much of the plantain is still un-eaten. */
  fraction: number;
  /** Bump this on every draw to fire a one-shot "slice cut" flash at the cut end. */
  flashSignal: number;
}

// A plantain lying on its side, drawn intentionally long/stretched (viewBox ~5.5:1) so it reads
// as a progress bar rather than the near-square Home logo. The body is clipped from the right as
// the Bunch empties, leaving a flat "cut face" — which is exactly where slices fly off from.
const PLANTAIN_PATH =
  'M 10 20 C 26 8, 120 5, 198 12 C 207 13, 211 16, 211 20 C 211 24, 207 27, 198 28 C 120 35, 26 32, 10 20 Z';
const HIGHLIGHT_PATH = 'M 34 12 C 100 9, 150 10, 188 14 C 150 14, 100 14, 34 16 Z';
const STEM_PATH = 'M 12 20 C 4 16, 3 24, 9 25 C 12 24, 12 22, 12 20 Z';
// Faint cross-cut segment lines suggesting a sliceable plantain.
const SEGMENT_XS = [46, 74, 102, 130, 158, 186];

const BunchPlantain = forwardRef<HTMLSpanElement, Props>(function BunchPlantain(
  { fraction, flashSignal },
  cutRef,
) {
  const fillRef = useRef<HTMLDivElement>(null);
  const firstFlash = useRef(true);

  // Re-trigger the cut flash whenever flashSignal changes (but not on first mount).
  useEffect(() => {
    if (firstFlash.current) {
      firstFlash.current = false;
      return;
    }
    const el = fillRef.current;
    if (!el) return;
    el.classList.remove('cutting');
    void el.offsetWidth; // force reflow so re-adding the class restarts the animation
    el.classList.add('cutting');
    const t = setTimeout(() => el.classList.remove('cutting'), 280);
    return () => clearTimeout(t);
  }, [flashSignal]);

  // Never let it fully vanish before the game ends — keep a nub visible.
  const pct = Math.max(7, Math.min(100, fraction * 100));

  return (
    <div className="bunch-plantain-track" aria-hidden="true">
      <div className="bunch-plantain-fill" ref={fillRef} style={{ width: `${pct}%` }}>
        <svg className="bunch-plantain-svg" viewBox="0 0 220 40" preserveAspectRatio="none">
          <path
            d={PLANTAIN_PATH}
            fill="#a8c94a"
            stroke="#0f2f1e"
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <path d={HIGHLIGHT_PATH} fill="#eef4d6" opacity={0.5} />
          {SEGMENT_XS.map((x) => (
            <path
              key={x}
              d={`M ${x} 10 C ${x - 3} 20, ${x - 3} 20, ${x} 30`}
              stroke="#0f2f1e"
              strokeWidth={1.4}
              strokeLinecap="round"
              opacity={0.28}
              fill="none"
            />
          ))}
          <path d={STEM_PATH} fill="#5c3d1e" stroke="#0f2f1e" strokeWidth={2} strokeLinejoin="round" />
        </svg>
      </div>
      {/* Zero-size anchor at the cut end — SliceFlyLayer measures this as each slice's origin. */}
      <span className="bunch-plantain-cut" ref={cutRef} style={{ left: `${pct}%` }} />
    </div>
  );
});

export default BunchPlantain;
