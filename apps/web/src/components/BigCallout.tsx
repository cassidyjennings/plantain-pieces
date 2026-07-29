import type { CSSProperties } from 'react';

interface Props {
  text: string;
  /** Desktop/maximum font size in px. The rendered size is fluid below that (see below). */
  size?: number;
}

/** Animated "PEEL! / DUMP! / PLANTAINS!" overlay. Mount only while visible — the entrance
 * animation replays each time it's mounted, and unmounting after ~900ms is how callers clear it.
 *
 * The size is a *ceiling*, not a fixed value: `size` px was hardcoded before, and at 64px
 * "PLANTAINS!" is ~380px wide with `white-space: nowrap`, so it ran off the edge of a 375px
 * phone. It now scales with the viewport and only reaches `size` when there's room for it. The
 * stroke width is derived from the same custom property so it stays proportional at every size
 * instead of staying fat on a small phone. */
export default function BigCallout({ text, size = 64 }: Props) {
  return (
    <div
      className="big-callout"
      style={{ '--callout-size': `${size}px` } as CSSProperties}
    >
      {text}
    </div>
  );
}
