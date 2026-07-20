import { type AvatarConfig, normalizeAvatarConfig } from '@plantain/shared';

/** A customizable plantain avatar rendered as inline SVG. Layers accessories (hat, glasses,
 * hair) over a colored plantain body. Reused in the Lobby player grid, the profile screen,
 * and match history. Accepts any (possibly empty/legacy) config; normalizes to defaults. */

interface AvatarProps {
  config?: AvatarConfig | null;
  size?: number;
  /** Adds a subtle ring — used for the current player / host emphasis. */
  ring?: boolean;
}

const BODY_FILL: Record<string, string> = {
  ripe: '#f4c542',
  green: '#a7c957',
  golden: '#e39a2f',
  speckled: '#f4c542',
};
const BODY_STROKE: Record<string, string> = {
  ripe: '#c98f1e',
  green: '#6f9134',
  golden: '#b06f16',
  speckled: '#c98f1e',
};

export default function Avatar({ config, size = 52, ring = false }: AvatarProps) {
  const c = normalizeAvatarConfig(config ?? {});
  const fill = BODY_FILL[c.base] ?? BODY_FILL.ripe;
  const stroke = BODY_STROKE[c.base] ?? BODY_STROKE.ripe;

  return (
    <svg
      className="avatar-svg"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Plantain avatar"
      style={ring ? { boxShadow: '0 0 0 3px var(--color-secondary)', borderRadius: '50%' } : undefined}
    >
      <circle cx="32" cy="32" r="32" fill="var(--color-surface-inner)" />
      {/* stem */}
      <rect x="30" y="3" width="4" height="7" rx="2" fill="#6b4a2b" />
      {/* body */}
      <path
        d="M32 8 C 22 8 18 20 18 33 C 18 48 24 57 32 57 C 40 57 46 48 46 33 C 46 20 42 8 32 8 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="2"
      />
      {c.base === 'speckled' && (
        <g fill={stroke} opacity="0.55">
          <ellipse cx="26" cy="24" rx="1.6" ry="1" />
          <ellipse cx="38" cy="30" rx="1.8" ry="1.1" />
          <ellipse cx="29" cy="46" rx="1.5" ry="0.9" />
          <ellipse cx="40" cy="42" rx="1.4" ry="0.9" />
        </g>
      )}
      {/* face */}
      <g fill="#3a2c12">
        <circle cx="27" cy="35" r="2.4" />
        <circle cx="37" cy="35" r="2.4" />
      </g>
      <path d="M27 42 Q 32 46 37 42" fill="none" stroke="#3a2c12" strokeWidth="2" strokeLinecap="round" />

      <Hair kind={c.hair ?? 'none'} />
      <Glasses kind={c.glasses ?? 'none'} />
      <Hat kind={c.hat ?? 'none'} />
    </svg>
  );
}

function Hat({ kind }: { kind: string }) {
  switch (kind) {
    case 'straw':
      return (
        <g>
          <ellipse cx="32" cy="15" rx="18" ry="4.5" fill="#d8b471" stroke="#a97c3c" strokeWidth="1.2" />
          <path d="M22 15 Q 24 5 32 5 Q 40 5 42 15 Z" fill="#e5c67f" stroke="#a97c3c" strokeWidth="1.2" />
        </g>
      );
    case 'party':
      return (
        <g>
          <path d="M32 0 L 40 15 L 24 15 Z" fill="#ff6b9d" stroke="#c94574" strokeWidth="1.2" />
          <circle cx="32" cy="1" r="2.2" fill="#ffe08a" />
        </g>
      );
    case 'crown':
      return (
        <path
          d="M21 15 L 21 7 L 26 11 L 32 5 L 38 11 L 43 7 L 43 15 Z"
          fill="#ffd34d"
          stroke="#d9a72c"
          strokeWidth="1.2"
        />
      );
    case 'beanie':
      return (
        <g>
          <path d="M20 16 Q 22 4 32 4 Q 42 4 44 16 Z" fill="#5aa9e6" stroke="#3d7cbf" strokeWidth="1.2" />
          <rect x="19" y="14" width="26" height="4.5" rx="2.2" fill="#3d7cbf" />
        </g>
      );
    default:
      return null;
  }
}

function Glasses({ kind }: { kind: string }) {
  switch (kind) {
    case 'round':
      return (
        <g fill="none" stroke="#3a2c12" strokeWidth="1.6">
          <circle cx="27" cy="35" r="4.4" />
          <circle cx="37" cy="35" r="4.4" />
          <line x1="31.4" y1="35" x2="32.6" y2="35" />
        </g>
      );
    case 'shades':
      return (
        <g fill="#26343d" stroke="#111" strokeWidth="1">
          <rect x="22" y="31.5" width="8.5" height="6.5" rx="2.5" />
          <rect x="33.5" y="31.5" width="8.5" height="6.5" rx="2.5" />
          <line x1="30.5" y1="34" x2="33.5" y2="34" stroke="#111" strokeWidth="1.4" />
        </g>
      );
    case 'star':
      return (
        <g fill="none" stroke="#ff6b9d" strokeWidth="1.6">
          <circle cx="27" cy="35" r="4.4" />
          <circle cx="37" cy="35" r="4.4" />
          <line x1="31.4" y1="35" x2="32.6" y2="35" />
          <circle cx="45" cy="30" r="1.6" fill="#ffe08a" stroke="none" />
        </g>
      );
    default:
      return null;
  }
}

function Hair({ kind }: { kind: string }) {
  switch (kind) {
    case 'swoop':
      return <path d="M20 16 Q 30 6 45 12 Q 38 14 34 12 Q 26 10 20 16 Z" fill="#5a3a1c" />;
    case 'curls':
      return (
        <g fill="#5a3a1c">
          <circle cx="22" cy="13" r="3.4" />
          <circle cx="29" cy="10" r="3.6" />
          <circle cx="36" cy="10" r="3.6" />
          <circle cx="43" cy="13" r="3.4" />
        </g>
      );
    case 'mohawk':
      return <path d="M29 12 L 32 2 L 35 12 Z" fill="#e6564c" />;
    default:
      return null;
  }
}
