interface Props {
  text: string;
}

/** A small "ⓘ" affordance that reveals an explanation on hover/focus — CSS-only, no JS state,
 * so it can sit next to any button without needing to wire up open/close logic. */
export default function InfoTooltip({ text }: Props) {
  return (
    <span className="info-tooltip" tabIndex={0}>
      <span className="info-tooltip-icon" aria-hidden="true">
        i
      </span>
      <span className="info-tooltip-bubble" role="tooltip">
        {text}
      </span>
    </span>
  );
}
