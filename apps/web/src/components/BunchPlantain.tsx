import { forwardRef, useEffect, useState } from 'react';

interface Props {
  /** 0-1 of the Bunch remaining. Drives how much of the plantain is un-eaten. */
  fraction: number;
  /** Bump this on every draw to fire a one-shot "slice cut" flash at the cut end. */
  flashSignal: number;
}

// A long, curved plantain — the brand logo laid on its side and stretched — sliced from the tip
// (right end) as the Bunch empties. No groove/track: it's just the fruit on the top-bar surface.
// Geometry, colors, and timings are lifted verbatim from the design handoff
// (design_handoff_plantain_meter), viewBox 0 0 240 76, stem/blunt end left, tip right.
const BODY_PATH =
  'M 20 28 C 60 33, 105 36, 145 36 C 180 36, 200 34, 214 30 C 224 27, 226 44, 216 48 C 205 60, 175 69, 135 70 C 98 71, 60 65, 26 51 C 14 47, 12 33, 20 28 Z';
const STEM_PATH = 'M 16 33 C 6 28, 4 44, 12 46 C 18 47, 20 39, 16 33 Z';
const SEGMENT_PATHS = [
  'M 60 35 C 57 44, 57 56, 60 62',
  'M 100 38 C 97 48, 97 61, 100 66',
  'M 140 38 C 137 48, 137 62, 140 67',
  'M 175 38 C 172 47, 172 60, 175 65',
  'M 200 35 C 197 43, 197 54, 200 59',
];

// Cut-face ellipse samples: body centre-Y and half-thickness at points along the X axis, so the
// slice's round cross-section is sized to the plantain's actual thickness at that point.
const XS = [20, 60, 105, 145, 180, 205, 216, 224];
const CY = [37.5, 48.5, 53, 53, 52, 46, 39, 38];
const RY = [9.5, 15.5, 17, 17, 16, 14, 9, 3];

function interp(x: number, xs: number[], ys: number[]): number {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  for (let i = 0; i < xs.length - 1; i++) {
    if (x <= xs[i + 1]) {
      const t = (x - xs[i]) / (xs[i + 1] - xs[i]);
      return ys[i] + (ys[i + 1] - ys[i]) * t;
    }
  }
  return ys[ys.length - 1];
}

const BunchPlantain = forwardRef<HTMLSpanElement, Props>(function BunchPlantain(
  { fraction, flashSignal },
  cutRef,
) {
  // The cut jumps instantly to the new position (plus a flash) rather than tweening — a CSS
  // transition on the clip-path would desync the flat green edge from the cut-face ellipse, since
  // the ellipse is positioned by attribute every render, not transitioned.
  const pct = fraction <= 0 ? 0 : Math.max(8, Math.min(100, fraction * 100));
  const cutX = (pct / 100) * 240;
  const faceCy = interp(cutX, XS, CY);
  const faceRy = Math.max(0, interp(cutX, XS, RY));
  const faceRx = Math.max(1.8, faceRy * 0.5);
  const faceOpacity = pct > 0 && pct < 99.4 ? 1 : 0;

  const [flashKey, setFlashKey] = useState(0);
  useEffect(() => {
    // Skip the very first mount — only re-fire on actual draws.
    if (flashSignal === 0) return;
    setFlashKey((k) => k + 1);
  }, [flashSignal]);

  return (
    <div className="bunch-plantain" aria-hidden="true">
      <svg
        className="bunch-plantain-body"
        viewBox="0 0 240 76"
        preserveAspectRatio="none"
        style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}
      >
        <path d={BODY_PATH} fill="#a8c94a" stroke="#0f2f1e" strokeWidth={3} strokeLinejoin="round" />
        <g className="bunch-plantain-segments">
          {SEGMENT_PATHS.map((d) => (
            <path key={d} d={d} stroke="#0f2f1e" strokeWidth={1.4} strokeLinecap="round" fill="none" />
          ))}
        </g>
        <path d={STEM_PATH} fill="#5c3d1e" stroke="#0f2f1e" strokeWidth={3} strokeLinejoin="round" />
      </svg>
      <svg className="bunch-plantain-face" viewBox="0 0 240 76" preserveAspectRatio="none">
        <ellipse
          cx={cutX}
          cy={faceCy}
          rx={faceRx}
          ry={faceRy}
          fill="#f4e79a"
          stroke="#0f2f1e"
          strokeWidth={3}
          opacity={faceOpacity}
        />
      </svg>
      {/* Zero-size anchor at the cut end — SliceFlyLayer measures this as each slice's origin. */}
      <span className="bunch-plantain-cut" ref={cutRef} style={{ left: `${pct}%` }} />
      {flashKey > 0 && faceOpacity > 0 && (
        <div
          key={flashKey}
          className="bunch-plantain-flash"
          style={{
            left: `calc(${pct}% - 5px)`,
            top: `${((faceCy - faceRy) / 76) * 100}%`,
            height: `${((faceRy * 2) / 76) * 100}%`,
          }}
        />
      )}
    </div>
  );
});

export default BunchPlantain;
