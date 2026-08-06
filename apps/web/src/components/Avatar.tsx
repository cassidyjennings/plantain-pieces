import { useId } from 'react';
import { type AvatarConfig, normalizeAvatarConfig } from '@plantain/shared';

/** A customizable plantain avatar rendered as inline SVG. Layers accessories (hat, glasses,
 * hair) over a colored plantain body. Reused in the Lobby player grid, the profile screen,
 * and match history. Accepts any (possibly empty/legacy) config; normalizes to defaults.
 *
 * The SVG background is deliberately transparent so the avatar sits on whatever surface it's
 * placed on — an opaque disc behind it only looked right on the one background it was picked
 * for and read as a stray dark circle everywhere else. */

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

/** Stina's curls — her own browns, deliberately not the generic HAIR_* tokens, so retuning the
 * shared hair color can't quietly restyle a bespoke character. */
const STINA_HAIR = '#5c3a1e';
const STINA_HAIR_LIGHT = '#8a5d2c';
const STINA_HAIR_SHADE = '#40270f';

const HAIR_FILL = '#5a3a1c';
const HAIR_SHADE = '#41290f';
const MOHAWK_FILL = '#e6564c';
const MOHAWK_SHADE = '#b93a32';

/** Every hat's crown tops out at roughly this y. The mohawk is redrawn above this line on top of
 * the hat so its spikes poke through instead of vanishing under the brim. */
const HAT_CROWN_TOP = 5.5;

export default function Avatar({ config, size = 52, ring = false }: AvatarProps) {
  const c = normalizeAvatarConfig(config ?? {});

  // Stina is a complete character, not a body tone: she ships her own hair, glasses, eyes and
  // lips. Layering the generic accessory slots over her would collide (the plain face dots would
  // show through her eyes, a hat would sit inside her curls), so this base short-circuits the
  // whole accessory stack rather than adding to it. Her body path is byte-identical to the
  // generic one, so she still reads as the same plantain.
  if (c.base === 'stina') return <StinaAvatar size={size} ring={ring} />;

  const fill = BODY_FILL[c.base] ?? BODY_FILL.ripe;
  const stroke = BODY_STROKE[c.base] ?? BODY_STROKE.ripe;
  // Several avatars render on one page, so the trucker hat's mesh pattern and the mohawk's clip
  // need ids unique per instance — duplicate ids would make every avatar reuse whichever
  // definition resolved first.
  const uid = useId();
  const meshId = `mesh-${uid}`;
  const peekClipId = `peek-${uid}`;

  const hat = c.hat ?? 'none';
  const hair = c.hair ?? 'none';

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
      {/* face — eyes sit a bit above center so there's clear room below them for glasses to rest
          on and, further down, for the mustache/goatee to sit without crowding the lenses. */}
      <g fill="#3a2c12">
        <circle cx="27" cy="32.5" r="2.4" />
        <circle cx="37" cy="32.5" r="2.4" />
      </g>
      <path d="M27 42 Q 32 46 37 42" fill="none" stroke="#3a2c12" strokeWidth="2" strokeLinecap="round" />

      <Hair kind={hair} />
      <Glasses kind={c.glasses ?? 'none'} />
      <Hat kind={hat} meshId={meshId} />

      {/* A mohawk under a hat would otherwise be completely swallowed by it. Redrawing just the
          part above every hat's crown, after the hat, makes the spikes poke through. */}
      {hair === 'mohawk' && hat !== 'none' && (
        <>
          <defs>
            <clipPath id={peekClipId}>
              <rect x="0" y="0" width="64" height={HAT_CROWN_TOP} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${peekClipId})`}>
            <Mohawk />
          </g>
        </>
      )}
    </svg>
  );
}

/**
 * Stina — a bespoke plantain, transcribed from a supplied design.
 *
 * Deliberately self-contained rather than composed from the accessory slots: her curls are three
 * separate layers that sit BOTH behind and in front of the body (back volume, top crown, outer
 * side falls), which the generic `<Hair>` slot can't express since it renders in one pass after
 * the body. Draw order below is load-bearing — reordering the groups buries her face.
 */
function StinaAvatar({ size, ring }: { size: number; ring: boolean }) {
  return (
    <svg
      className="avatar-svg"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Stina, a plantain avatar"
      style={ring ? { boxShadow: '0 0 0 3px var(--color-secondary)', borderRadius: '50%' } : undefined}
    >
      {/* Hair, back layer — the volume that reads behind the head. */}
      <g fill={STINA_HAIR}>
        <ellipse cx="20.5" cy="44" rx="9" ry="17" />
        <ellipse cx="43.5" cy="44" rx="9" ry="17" />
        <circle cx="22.6" cy="28.8" r="4.3" /><circle cx="21.2" cy="35.4" r="4.2" />
        <circle cx="20.2" cy="41.8" r="4" /><circle cx="19.8" cy="47.4" r="3.7" />
        <circle cx="20.4" cy="52.8" r="3.5" /><circle cx="21.6" cy="57.4" r="3.2" />
        <circle cx="26" cy="32" r="3.4" /><circle cx="25" cy="39" r="3.3" />
        <circle cx="24.4" cy="45.6" r="3.1" /><circle cx="22.4" cy="35.6" r="2.6" />
        <circle cx="21.6" cy="42.4" r="2.6" />
        <circle cx="41.4" cy="28.8" r="4.3" /><circle cx="42.8" cy="35.4" r="4.2" />
        <circle cx="43.8" cy="41.8" r="4" /><circle cx="44.2" cy="47.4" r="3.7" />
        <circle cx="43.6" cy="52.8" r="3.5" /><circle cx="42.4" cy="57.4" r="3.2" />
        <circle cx="41.6" cy="35.6" r="2.6" /><circle cx="42.4" cy="42.4" r="2.6" />
        <circle cx="38" cy="32" r="3.4" /><circle cx="39" cy="39" r="3.3" />
        <circle cx="39.6" cy="45.6" r="3.1" />
      </g>
      <g fill={STINA_HAIR_SHADE} opacity="0.4">
        <circle cx="42.6" cy="36.6" r="1.5" /><circle cx="21" cy="53" r="1.4" />
        <circle cx="43" cy="53" r="1.4" />
      </g>

      {/* Body — same path as every other plantain, so she reads as the same fruit. */}
      <rect x="30" y="3" width="4" height="7" rx="2" fill="#5c3d1e" />
      <path
        d="M32 8 C 22 8 18 20 18 33 C 18 48 24 57 32 57 C 40 57 46 48 46 33 C 46 20 42 8 32 8 Z"
        fill="#e3b184"
        stroke="#b07f4e"
        strokeWidth="2"
      />
      <path
        d="M40.4 12.6 C 44.4 19 45.6 26 45.4 34 C 45.2 45 41.4 53.4 35.6 56.4 C 42 55.2 46 46.6 46 33 C 46 24 44.4 16.6 40.4 12.6 Z"
        fill="#cf9a68"
        opacity="0.55"
      />

      {/* Hair, top crown. */}
      <g fill={STINA_HAIR}>
        <circle cx="26.4" cy="11.4" r="4.9" /><circle cx="32" cy="9.8" r="5.1" />
        <circle cx="37.6" cy="11.4" r="4.9" /><circle cx="22.4" cy="15.2" r="5.1" />
        <circle cx="29" cy="15" r="4.7" /><circle cx="35" cy="15" r="4.7" />
        <circle cx="41.6" cy="15.2" r="5.1" />
        <circle cx="25.2" cy="19.6" r="4.5" /><circle cx="38.8" cy="19.6" r="4.5" />
        <circle cx="21.4" cy="20.2" r="5" />
        <circle cx="42.6" cy="20.2" r="5" />
        <circle cx="20.4" cy="25.2" r="4.4" /><circle cx="23.4" cy="24" r="4" />
        <circle cx="43.6" cy="25.2" r="4.4" /><circle cx="40.6" cy="24" r="4" />
      </g>
      <g fill={STINA_HAIR_LIGHT} opacity="0.65">
        <circle cx="27.4" cy="10.6" r="1.9" /><circle cx="22.8" cy="14" r="1.8" />
        <circle cx="20.8" cy="19.4" r="1.8" />
        <circle cx="33.4" cy="10.2" r="1.6" />
      </g>
      <g fill={STINA_HAIR_SHADE} opacity="0.4">
        <circle cx="43.4" cy="21.4" r="1.8" />
        <circle cx="36.4" cy="13.4" r="1.5" />
      </g>

      {/* Eyes and brows. */}
      <ellipse cx="26.9" cy="32.4" rx="3.5" ry="3.9" fill="#fdf8ec" stroke="#b07f4e" strokeWidth="0.7" />
      <ellipse cx="37.1" cy="32.4" rx="3.5" ry="3.9" fill="#fdf8ec" stroke="#b07f4e" strokeWidth="0.7" />
      <circle cx="27.2" cy="32.8" r="2.3" fill="#2a1d0c" />
      <circle cx="37.4" cy="32.8" r="2.3" fill="#2a1d0c" />
      <circle cx="26.3" cy="31.7" r="1" fill="#ffffff" />
      <circle cx="36.5" cy="31.7" r="1" fill="#ffffff" />
      <path d="M28.6 34.1 L 29.1 35.1 L 30.1 35.6 L 29.1 36.1 L 28.6 37.1 L 28.1 36.1 L 27.1 35.6 L 28.1 35.1 Z" fill="#ffffff" />
      <path d="M38.8 34.1 L 39.3 35.1 L 40.3 35.6 L 39.3 36.1 L 38.8 37.1 L 38.3 36.1 L 37.3 35.6 L 38.3 35.1 Z" fill="#ffffff" />
      <path d="M23.6 26.4 Q 26.9 24.2 30.2 26.1" fill="none" stroke="#4a2c14" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M33.8 26.1 Q 37.1 24.2 40.4 26.4" fill="none" stroke="#4a2c14" strokeWidth="1.5" strokeLinecap="round" />

      {/* Glasses. */}
      <path d="M20.8 30.4 L 17.2 29.2 M43.2 30.4 L 46.8 29.2" stroke="#173d2a" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M31.4 32.4 L 32.6 32.4" stroke="#1c4632" strokeWidth="1.8" strokeLinecap="round" />
      <rect x="20.8" y="27.5" width="10.6" height="9.8" rx="4.6" fill="none" stroke="#1c4632" strokeWidth="2" />
      <rect x="32.6" y="27.5" width="10.6" height="9.8" rx="4.6" fill="none" stroke="#1c4632" strokeWidth="2" />
      <path d="M23.2 30 L 26 30 L 23.4 34 L 22.4 32.6 Z" fill="#ffffff" opacity="0.22" />
      <path d="M35 30 L 37.8 30 L 35.2 34 L 34.2 32.6 Z" fill="#ffffff" opacity="0.22" />

      {/* Lips. */}
      <path
        d="M28.6 45.2 Q 30.1 44 31.1 44.9 Q 32 44.3 32.9 44.9 Q 33.9 44 35.4 45.2 Q 33.9 47.8 32 47.8 Q 30.1 47.8 28.6 45.2 Z"
        fill="#c0496a"
        stroke="#8a2f4a"
        strokeWidth="0.9"
        strokeLinejoin="round"
      />
      <path d="M29.4 45.4 Q 32 46.2 34.6 45.4" fill="none" stroke="#8a2f4a" strokeWidth="0.7" strokeLinecap="round" />
      <ellipse cx="33.4" cy="46.6" rx="0.8" ry="0.5" fill="#ffffff" opacity="0.45" transform="rotate(-18 33.4 46.6)" />

      {/* Hair, outer side falls — drawn last so the curls frame the face in front of the body. */}
      <g fill={STINA_HAIR}>
        <circle cx="19.2" cy="26.2" r="5.2" /><circle cx="16.8" cy="32.2" r="5.3" />
        <circle cx="14.6" cy="38.2" r="5.2" /><circle cx="12.8" cy="44" r="4.9" />
        <circle cx="11.6" cy="49.4" r="4.4" /><circle cx="11.4" cy="54.4" r="4" />
        <circle cx="16.2" cy="56.6" r="3.6" /><circle cx="19" cy="55.6" r="3.2" /><circle cx="20.6" cy="58.6" r="2.8" />
        <circle cx="44.8" cy="26.2" r="5.2" /><circle cx="47.2" cy="32.2" r="5.3" />
        <circle cx="49.4" cy="38.2" r="5.2" /><circle cx="51.2" cy="44" r="4.9" />
        <circle cx="52.4" cy="49.4" r="4.4" /><circle cx="52.6" cy="54.4" r="4" />
        <circle cx="47.8" cy="56.6" r="3.6" /><circle cx="45" cy="55.6" r="3.2" /><circle cx="43.4" cy="58.6" r="2.8" />
      </g>
      <g fill={STINA_HAIR_LIGHT} opacity="0.65">
        <circle cx="18.4" cy="25.4" r="1.7" /><circle cx="16" cy="31.4" r="1.6" />
        <circle cx="13.8" cy="37.4" r="1.5" /><circle cx="12" cy="53.6" r="1.4" />
      </g>
      <g fill={STINA_HAIR_SHADE} opacity="0.4">
        <circle cx="45.6" cy="27.4" r="1.7" /><circle cx="48" cy="33.4" r="1.6" />
        <circle cx="50.2" cy="39.4" r="1.5" /><circle cx="52" cy="53.6" r="1.4" />
      </g>
    </svg>
  );
}

/** Regular star polygon, point-up. Used for the star glasses' lenses. */
function starPath(cx: number, cy: number, outer: number, inner: number, points = 5): string {
  const step = Math.PI / points;
  let d = '';
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + i * step;
    d += `${i === 0 ? 'M' : 'L'}${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)} `;
  }
  return `${d}Z`;
}

/** Trucker cap: orange bill, mesh side panels, white foam front. Drawn head-on to match the
 * avatar's straight-on face. Deliberately carries no lettering — an earlier version stamped
 * "HOST" across the front panel, but at the lobby's avatar sizes (34–60px) the word was a smudge,
 * so host status moved to the card stamp and this became a plain cosmetic hat. */
function TruckerHat({ meshId }: { meshId: string }) {
  return (
    <g>
      <defs>
        {/* Actual little holes rather than a flat tint, so the side panels still read as mesh
            when the avatar is drawn large on the profile screen. */}
        <pattern id={meshId} width="2.6" height="2.6" patternUnits="userSpaceOnUse">
          <rect width="2.6" height="2.6" fill="#ffb066" />
          <circle cx="1.3" cy="1.3" r="0.62" fill="#c46f1f" opacity="0.9" />
        </pattern>
      </defs>

      {/* Crown — mesh panels wrapping the sides. */}
      <path
        d="M19 16.5 Q 19 4.5 32 4.5 Q 45 4.5 45 16.5 Z"
        fill={`url(#${meshId})`}
        stroke="#b25f14"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      {/* White foam front panel. */}
      <path
        d="M24.2 16.5 Q 24.2 5.9 32 5.9 Q 39.8 5.9 39.8 16.5 Z"
        fill="#fbf4e2"
        stroke="#b25f14"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      {/* Bill, curving out over the brow. */}
      <path
        d="M17.2 16.5 Q 32 14.8 46.8 16.5 Q 46.8 21.2 32 21.6 Q 17.2 21.2 17.2 16.5 Z"
        fill="#ff9f43"
        stroke="#b25f14"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </g>
  );
}

function Hat({ kind, meshId }: { kind: string; meshId: string }) {
  switch (kind) {
    case 'trucker':
      return <TruckerHat meshId={meshId} />;
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
          {/* Cone first, then the brim ellipse over its base — a flat triangle sitting on nothing
              read as a paper cutout; the ellipse gives it a round rim to sit on. */}
          <path d="M32 1 L 40 15.5 L 24 15.5 Z" fill="#ff6b9d" stroke="#c94574" strokeWidth="1.2" />
          <path d="M27.2 6.8 L 36.8 6.8 L 38.4 9.7 L 25.6 9.7 Z" fill="#ffe08a" opacity="0.9" />
          <ellipse cx="32" cy="15.5" rx="9" ry="2.6" fill="#ff86b0" stroke="#c94574" strokeWidth="1.2" />
          <circle cx="32" cy="1" r="2.4" fill="#ffe08a" stroke="#c94574" strokeWidth="1" />
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
          <circle cx="27" cy="32.5" r="4.4" />
          <circle cx="37" cy="32.5" r="4.4" />
          <line x1="31.4" y1="32.5" x2="32.6" y2="32.5" />
        </g>
      );
    case 'shades':
      return (
        <g fill="#26343d" stroke="#111" strokeWidth="1">
          <rect x="22" y="29" width="8.5" height="6.5" rx="2.5" />
          <rect x="33.5" y="29" width="8.5" height="6.5" rx="2.5" />
          <line x1="30.5" y1="31.5" x2="33.5" y2="31.5" stroke="#111" strokeWidth="1.4" />
        </g>
      );
    case 'star':
      // Actual star-shaped lenses. The previous version drew round lenses with one small star
      // floating beside them, which just read as pink circles at avatar size.
      return (
        <g>
          <g fill="#ffd6e6" fillOpacity="0.75" stroke="#ff6b9d" strokeWidth="1.5" strokeLinejoin="round">
            <path d={starPath(26.6, 32.3, 6.2, 2.7)} />
            <path d={starPath(37.4, 32.3, 6.2, 2.7)} />
          </g>
          <line x1="31" y1="32.3" x2="33" y2="32.3" stroke="#ff6b9d" strokeWidth="1.5" />
          {/* Pupils kept visible through the tinted lenses so the face still reads. */}
          <g fill="#3a2c12" opacity="0.75">
            <circle cx="26.6" cy="32.7" r="1.5" />
            <circle cx="37.4" cy="32.7" r="1.5" />
          </g>
        </g>
      );
    case 'monocle':
      return (
        <g>
          {/* Lens tint stays very light — at 0.45 it washed the eye out completely and the whole
              thing read as a blank white disc stuck to the face. A dark outer rim (rather than
              just the gold ring) is what actually reads as a frame instead of a faint circle
              nearly lost against the golden body. The inset gold ring gives it a metal edge. */}
          <circle cx="37.4" cy="32.5" r="6" fill="#dff1f7" fillOpacity="0.16" stroke="#2a1c08" strokeWidth="1.6" />
          <circle cx="37.4" cy="32.5" r="4.9" fill="none" stroke="#e8c15a" strokeWidth="1" />
          {/* Glint, so the lens reads as glass rather than an empty ring. */}
          <path d="M34.2 29.9 Q 35.6 28.4 37.6 28.6" fill="none" stroke="#ffffff" strokeWidth="1.3" strokeLinecap="round" opacity="0.7" />
          {/* Chain drawn as a run of solid linked ovals rather than one thin stroked curve — the
              plain line all but vanished against the body; distinct links read as a real chain. */}
          <g fill="#c9a445" stroke="#7a5a17" strokeWidth="0.7">
            <ellipse cx="43.4" cy="37" rx="1.3" ry="1.8" transform="rotate(24 43.4 37)" />
            <ellipse cx="44.2" cy="40" rx="1.3" ry="1.8" transform="rotate(-18 44.2 40)" />
            <ellipse cx="44.3" cy="43.1" rx="1.3" ry="1.8" transform="rotate(24 44.3 43.1)" />
            <ellipse cx="43.8" cy="46.3" rx="1.3" ry="1.8" transform="rotate(-18 43.8 46.3)" />
          </g>
          <circle cx="43.2" cy="48.6" r="1.7" fill="#e8c15a" stroke="#7a5a17" strokeWidth="0.7" />
        </g>
      );
    default:
      return null;
  }
}

/** Spiked crest, drawn tall enough that its tips clear every hat's crown (see HAT_CROWN_TOP). */
function Mohawk() {
  return (
    <g>
      <path
        d="M26 16 L 27.6 3.6 L 29.6 9.2 L 32 0.8 L 34.4 9.2 L 36.4 3.6 L 38 16 Z"
        fill={MOHAWK_FILL}
        stroke={MOHAWK_SHADE}
        strokeWidth="1"
        strokeLinejoin="round"
      />
      {/* Shaded right half sells the crest as a ridge with a side to it rather than a flat zigzag. */}
      <path d="M32 0.8 L 34.4 9.2 L 36.4 3.6 L 38 16 L 32 16 Z" fill={MOHAWK_SHADE} opacity="0.35" />
    </g>
  );
}

function Hair({ kind }: { kind: string }) {
  switch (kind) {
    case 'swoop':
      // A side-swept fringe: it sits high on the right and sweeps down into a tail past the left
      // temple. The asymmetry is the whole point — earlier symmetric versions just read as a
      // brown cap sitting on the head, with no sense of direction.
      return (
        <g>
          <path
            d="M20.4 16.2
               C 21 6.6 27 5.4 32 5.8
               C 39.2 6.2 43.8 9.2 45.2 15.8
               C 43 12.4 38.4 10.8 33.8 12.4
               C 28.6 14.2 24 17.4 21.4 21
               Z"
            fill={HAIR_FILL}
          />
          {/* Highlight following the sweep, which is what makes the direction read at small size. */}
          <path
            d="M24 12.2 C 28.4 8.4 35.4 8 40.4 10.6 C 34.6 9.4 28.6 10.2 24 12.2 Z"
            fill="#8a5d2c"
            opacity="0.8"
          />
        </g>
      );
    case 'curls':
      // Overlapping lobes forming a full rounded cap. Four circles in a row read as beads.
      return (
        <g>
          <g fill={HAIR_FILL}>
            <circle cx="23.2" cy="15.4" r="4.1" />
            <circle cx="27.4" cy="11.2" r="4.6" />
            <circle cx="32" cy="9.4" r="4.9" />
            <circle cx="36.6" cy="11.2" r="4.6" />
            <circle cx="40.8" cy="15.4" r="4.1" />
            <circle cx="25.6" cy="17.6" r="3.4" />
            <circle cx="32" cy="14.4" r="4.2" />
            <circle cx="38.4" cy="17.6" r="3.4" />
          </g>
          {/* A few darker lobes give the mass some internal definition at larger sizes. */}
          <g fill={HAIR_SHADE} opacity="0.4">
            <circle cx="28.4" cy="12.8" r="2" />
            <circle cx="35.8" cy="13.2" r="1.8" />
            <circle cx="32.2" cy="9.8" r="1.7" />
          </g>
        </g>
      );
    case 'mohawk':
      return <Mohawk />;
    case 'mustache':
      // Sits in the gap between the eyes (now raised, see the face group above) and the mouth —
      // it used to start right under the eyes and clipped into the bottom of every glasses style.
      return (
        <path
          d="M25.6 40.4 Q 28.4 38.6 32 40.2 Q 35.6 38.6 38.4 40.4 Q 35.6 42.6 32 41 Q 28.4 42.6 25.6 40.4 Z"
          fill={HAIR_FILL}
        />
      );
    case 'goatee':
      return (
        <g fill={HAIR_FILL}>
          <path d="M28.6 46.4 Q 32 44.6 35.4 46.4 Q 35.8 52.4 32 54 Q 28.2 52.4 28.6 46.4 Z" />
          {/* Soul patch, which is what separates a goatee from a plain chin puff. */}
          <ellipse cx="32" cy="43.6" rx="2.1" ry="1.3" />
        </g>
      );
    default:
      return null;
  }
}
