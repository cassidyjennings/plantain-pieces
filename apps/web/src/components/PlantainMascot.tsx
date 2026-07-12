import type { CSSProperties } from 'react';

interface Props {
  /** Overall width in px; height follows the mascot's natural aspect ratio. */
  size?: number;
  /** 0-1. Drives how full the bunch looks — shrinks the outer peels first as it drops. */
  fraction?: number;
  /** Gentle idle sway, used on the Home screen. */
  sway?: boolean;
}

const PEEL_GRADIENT_A = 'linear-gradient(160deg,#e7e987,#a8c94a 55%,#78962f)';
const PEEL_GRADIENT_B = 'linear-gradient(160deg,#f2e58a,#d8b93f 55%,#a8842a)';

export default function PlantainMascot({ size = 100, fraction = 1, sway = false }: Props) {
  const h = size * 0.78;
  // Outer peels shrink away first as the bunch empties; the center peel holds on longest.
  const outerScale = Math.max(0, Math.min(1, fraction * 1.15));
  const centerScale = Math.max(0.15, Math.min(1, fraction));

  const peel = (
    leftPct: number,
    topPx: number,
    rotateDeg: number,
    gradient: string,
    wPct: number,
    hPct: number,
    scale: number,
  ): CSSProperties => ({
    position: 'absolute',
    left: leftPct * size,
    top: topPx,
    width: wPct * size,
    height: hPct * h,
    borderRadius: '50% 50% 50% 50% / 60% 60% 40% 40%',
    background: gradient,
    transform: `rotate(${rotateDeg}deg) scaleY(${scale})`,
    transformOrigin: 'top center',
    boxShadow: 'inset -4px -4px 8px rgba(0,0,0,0.25)',
    opacity: scale > 0.05 ? 1 : 0,
    transition: 'transform 400ms ease, opacity 400ms ease',
  });

  return (
    <div
      style={{
        position: 'relative',
        width: size,
        height: h,
        animation: sway ? 'bunchSway 4s ease-in-out infinite' : 'none',
      }}
      aria-hidden="true"
    >
      <div style={peel(0.18, 6, -20, PEEL_GRADIENT_A, 0.26, 0.9, outerScale)} />
      <div style={peel(0.38, 0, -2, PEEL_GRADIENT_B, 0.28, 1.0, centerScale)} />
      <div style={peel(0.6, 8, 18, PEEL_GRADIENT_A, 0.26, 0.88, outerScale)} />
      <div
        style={{
          position: 'absolute',
          left: size * 0.44,
          top: -6,
          width: size * 0.16,
          height: size * 0.12,
          background: '#5c3d1e',
          borderRadius: '4px 4px 2px 2px',
        }}
      />
    </div>
  );
}
