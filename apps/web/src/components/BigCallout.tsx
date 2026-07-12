interface Props {
  text: string;
  size?: number;
}

/** Animated "PEEL! / DUMP! / PLANTAINS!" overlay. Mount only while visible — the entrance
 * animation replays each time it's mounted, and unmounting after ~900ms is how callers clear it. */
export default function BigCallout({ text, size = 64 }: Props) {
  return (
    <div
      className="big-callout"
      style={{ fontSize: size, WebkitTextStroke: `${Math.round(size / 21)}px var(--color-text-on-accent)` }}
    >
      {text}
    </div>
  );
}
