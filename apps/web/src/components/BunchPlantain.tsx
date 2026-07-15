import { forwardRef, useEffect, useState } from 'react';

interface Props {
  /** 0-1 of the Bunch remaining. Drives how much of the plantain is un-eaten. */
  fraction: number;
  /** Bump this on every draw to fire a one-shot "slice cut" flash at the cut end. */
  flashSignal: number;
}

// A long, curved plantain — the brand logo laid on its side and stretched — sliced from the tip
// (right end) as the Bunch empties. No groove/track: it's just the fruit on the top-bar surface.
// Body/segment geometry is lifted from the design handoff (design_handoff_plantain_meter),
// viewBox 0 0 240 76, stem/blunt end left, tip right.
const BODY_PATH =
  'M 20 28 C 60 33, 105 36, 145 36 C 180 36, 200 34, 214 30 C 224 27, 226 44, 216 48 C 205 60, 175 69, 135 70 C 98 71, 60 65, 26 51 C 14 47, 12 33, 20 28 Z';
// The stem knob, repositioned to sit centered on the body's actual left-end cross-section (the
// handoff's hand-authored position read as sitting noticeably low against the real curve).
const STEM_PATH = 'M 16 27 C 6 22, 4 38, 12 40 C 18 41, 20 33, 16 27 Z';
const SEGMENT_PATHS = [
  'M 60 35 C 57 44, 57 56, 60 62',
  'M 100 38 C 97 48, 97 61, 100 66',
  'M 140 38 C 137 48, 137 62, 140 67',
  'M 175 38 C 172 47, 172 60, 175 65',
  'M 200 35 C 197 43, 197 54, 200 59',
];

type Pt = [number, number];
type CubicSeg = [Pt, Pt, Pt, Pt]; // [p0, c1, c2, p1]

// The body outline as its 6 cubic bezier segments (verbatim from BODY_PATH's M/C commands), used
// to derive the cut-face ellipse geometry directly from the real curve instead of a hand-typed
// sample table — a hand-authored table drifted a couple of units off the actual path, which read
// as the cut face floating below and larger than the clipped edge it's supposed to cap.
const BODY_SEGMENTS: CubicSeg[] = [
  [[20, 28], [60, 33], [105, 36], [145, 36]],
  [[145, 36], [180, 36], [200, 34], [214, 30]],
  [[214, 30], [224, 27], [226, 44], [216, 48]],
  [[216, 48], [205, 60], [175, 69], [135, 70]],
  [[135, 70], [98, 71], [60, 65], [26, 51]],
  [[26, 51], [14, 47], [12, 33], [20, 28]],
];

function cubicAt([p0, c1, c2, p1]: CubicSeg, t: number): Pt {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return [a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1]];
}

// Dense one-time sample of the whole closed outline, used to find where a vertical line at a given
// X crosses the body (top and bottom), by linear-interpolating between adjacent samples that
// straddle it.
const SAMPLES_PER_SEGMENT = 200;
const BOUNDARY: Pt[] = BODY_SEGMENTS.flatMap((seg) =>
  Array.from({ length: SAMPLES_PER_SEGMENT + 1 }, (_, i) => cubicAt(seg, i / SAMPLES_PER_SEGMENT)),
);

/** The body's centre-Y and half-thickness at a given X, read directly off the real outline.
 * Returns null outside the body's horizontal extent (e.g. past the tip apex, ~x=222.6) — the
 * caller hides the cut face there since there's no real cut edge to cap. */
function bodyThicknessAt(x: number): { cy: number; ry: number } | null {
  const hits: number[] = [];
  for (let i = 1; i < BOUNDARY.length; i++) {
    const [px, py] = BOUNDARY[i - 1];
    const [cx, cy] = BOUNDARY[i];
    if (px === cx) continue;
    if ((px - x) * (cx - x) <= 0) {
      const t = (x - px) / (cx - px);
      hits.push(py + (cy - py) * t);
    }
  }
  if (hits.length < 2) return null;
  const min = Math.min(...hits);
  const max = Math.max(...hits);
  return { cy: (min + max) / 2, ry: (max - min) / 2 };
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
  const thickness = bodyThicknessAt(cutX);
  const faceCy = thickness?.cy ?? 0;
  const faceRy = thickness?.ry ?? 0;
  const faceRx = Math.max(1.8, faceRy * 0.5);
  const faceOpacity = pct > 0 && thickness && faceRy > 0.5 ? 1 : 0;

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
