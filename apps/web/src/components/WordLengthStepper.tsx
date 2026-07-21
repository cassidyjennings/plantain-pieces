interface WordLengthStepperProps {
  value: number;
  maxValue: number;
  onChange: (next: number) => void;
  disabled?: boolean;
}

/** A plain +/- stepper for the minimum accepted word length. */
export default function WordLengthStepper({ value, maxValue, onChange, disabled = false }: WordLengthStepperProps) {
  return (
    <div className="length-stepper">
      <button
        type="button"
        className="length-stepper-btn"
        aria-label="Decrease minimum word length"
        disabled={disabled || value <= 1}
        onClick={() => onChange(Math.max(1, value - 1))}
      >
        −
      </button>
      <span className="length-stepper-value">{value}</span>
      <button
        type="button"
        className="length-stepper-btn"
        aria-label="Increase minimum word length"
        disabled={disabled || value >= maxValue}
        onClick={() => onChange(Math.min(maxValue, value + 1))}
      >
        +
      </button>
    </div>
  );
}
