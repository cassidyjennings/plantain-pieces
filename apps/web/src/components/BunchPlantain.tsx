import { forwardRef, useEffect, useId, useRef, useState } from 'react';

interface Props {
  /** 0-1 of the Bunch remaining. Drives how much of the plantain is un-eaten. */
  fraction: number;
  /** Bump this on every draw to fire a one-shot "slice cut" flash at the cut end. */
  flashSignal: number;
}

// A single fat plantain, laid on its side with the stem at the left, sliced away from the tip
// (right end) as the Bunch empties — the logo's own drawing style rather than a stretched sliver.
// Body outline and the cut face are solved from the same centreline/thickness functions so the
// cut face always sits exactly on the cut instead of floating near it. Geometry lifted from the
// design handoff (design_handoff_bunch_meter), stem/blunt end left, tip right.
const X0 = 22;
const X1 = 206; // body runs 184 units long
const CY0 = 44;
// The handoff's SAG/R (22/26) drew a plantain tall enough to squeeze the board area on short
// viewports. Slimmed to 16/21 — note this barely moves the body's TOP edge (a flatter centreline
// raises it by nearly as much as the thinner body lowers it), so the height comes off the belly
// and STREAK_PATH, which rides the upper surface, still lands correctly without re-authoring.
const SAG = 16; // centreline bow, gentle downward
const R = 21; // half-thickness at the belly
const MIN_FRACTION = 1 / 16; // below this the drawn nub collides with the stem

// The viewBox is cropped tight to the ink rather than the handoff's 0 0 232 108: at these
// constants the drawn content (stem crown at y≈27.4 incl. stroke, belly bottom at y≈83.5) only
// ever occupies the middle of that box, and the leftover ~37% was pure dead vertical space in the
// top bar. Everything positioned as a percentage of the graphic must be measured against these,
// not against raw viewBox coordinates.
const VB_X = 0;
const VB_Y = 25;
const VB_W = 232;
const VB_H = 62;

const centreY = (u: number) => {
  const t = 2 * u - 1;
  return CY0 + SAG * (1 - t * t);
};
const halfThickness = (u: number) => {
  const t = 2 * u - 1;
  return R * Math.pow(1 - Math.pow(Math.abs(t), 4), 0.42);
};
const bodyX = (u: number) => X0 + (X1 - X0) * u;

type Pt = [number, number];

/** Catmull-Rom through the sampled points, emitted as cubic beziers. */
function smooth(points: Pt[]): string {
  const n = (v: number) => Math.round(v * 10) / 10;
  let d = `M ${n(points[0][0])} ${n(points[0][1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? points[i + 1];
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${n(c1[0])} ${n(c1[1])}, ${n(c2[0])} ${n(c2[1])}, ${n(p2[0])} ${n(p2[1])}`;
  }
  return d;
}

// Sampled once at module load — 15 samples per edge is smooth enough at every size the product
// uses, and the body's shape never changes, only how much of it is clipped away.
const BODY_PATH = (() => {
  const N = 14;
  const top: Pt[] = [];
  const bottom: Pt[] = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const x = bodyX(u);
    const cy = centreY(u);
    const r = halfThickness(u);
    top.push([x, cy - r]);
    bottom.push([x, cy + r]);
  }
  return `${smooth(top)} ${smooth([...bottom].reverse()).replace(/^M/, 'L')} Z`;
})();

const STEM_PATH = 'M 24 40 C 15 29, 4 27, 0 34 C 5 43, 13 50, 24 51 Z';
const STREAK_PATH = 'M 58 42 C 88 46, 138 46, 168 40 C 138 52, 88 52, 58 42 Z';

const TWEEN_MS = 200; // matches --transition-base

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

const BunchPlantain = forwardRef<HTMLSpanElement, Props>(function BunchPlantain(
  { fraction, flashSignal },
  cutRef,
) {
  const clipId = `bunch-cut-${useId()}`;
  const raw = Math.max(0, Math.min(1, fraction));
  const target = raw <= 0 ? 0 : Math.max(MIN_FRACTION, raw);

  // The clip width and the cut face are both re-derived from this single animated fraction each
  // frame, so they can never desync mid-transition (the failure mode a naive CSS transition on
  // the clip plus per-render ellipse attributes would hit).
  const [f, setF] = useState(target);
  const fRef = useRef(f);
  fRef.current = f;

  useEffect(() => {
    const from = fRef.current;
    if (prefersReducedMotion() || from === target) {
      setF(target);
      return;
    }
    let rafId: number | null = null;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / TWEEN_MS);
      const next = from + (target - from) * easeOutCubic(t);
      setF(next);
      fRef.current = next;
      if (t < 1) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [target]);

  const cutX = bodyX(f);
  const cutCy = centreY(f);
  const cutR = halfThickness(f);
  const showBody = f > 0.001;
  const showFace = f > 0.001 && f < 0.999;
  const leftPct = ((cutX - VB_X) / VB_W) * 100;
  const topPct = ((cutCy - VB_Y) / VB_H) * 100;

  const [flashKey, setFlashKey] = useState(0);
  useEffect(() => {
    // Skip the very first mount — only re-fire on actual draws.
    if (flashSignal === 0) return;
    setFlashKey((k) => k + 1);
  }, [flashSignal]);

  return (
    <div className="bunch-plantain" aria-hidden="true">
      <svg className="bunch-plantain-svg" viewBox={`${VB_X} ${VB_Y} ${VB_W} ${VB_H}`}>
        <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
          <rect x={VB_X} y={VB_Y} width={cutX} height={VB_H} />
        </clipPath>
        <path
          d={STEM_PATH}
          fill="var(--color-plantain-stem)"
          stroke="var(--color-plantain-ink)"
          strokeWidth={5}
          strokeLinejoin="round"
        />
        {showBody && (
          <g clipPath={`url(#${clipId})`}>
            <path
              d={BODY_PATH}
              fill="var(--color-plantain-peel)"
              stroke="var(--color-plantain-ink)"
              strokeWidth={5}
              strokeLinejoin="round"
            />
            <path d={STREAK_PATH} fill="#eef4d6" opacity={0.55} />
          </g>
        )}
        {showFace && (
          <ellipse
            cx={cutX}
            cy={cutCy}
            rx={cutR * 0.4}
            ry={cutR}
            fill="var(--color-plantain-flesh)"
            stroke="var(--color-plantain-ink)"
            strokeWidth={5}
          />
        )}
      </svg>
      {/* Zero-size anchor at the cut face — SliceFlyLayer measures this as each slice's origin. */}
      <span
        className="bunch-plantain-cut"
        ref={cutRef}
        style={{ left: `${leftPct}%`, top: `${topPct}%` }}
      />
      {flashKey > 0 && showFace && (
        <div
          key={flashKey}
          className="bunch-plantain-flash"
          style={{
            left: `${leftPct}%`,
            top: `${topPct}%`,
            height: `${((cutR * 2) / VB_H) * 100}%`,
          }}
        />
      )}
    </div>
  );
});

export default BunchPlantain;
