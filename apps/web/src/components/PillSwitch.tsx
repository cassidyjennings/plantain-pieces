interface PillSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}

/** A pill-shaped on/off switch. The knob sits on one side; the state word ("ON"/"OFF") shows
 * in the negative space on the opposite side, so which word is visible always matches where
 * the knob currently isn't. */
export default function PillSwitch({ checked, onChange, label }: PillSwitchProps) {
  return (
    <button
      type="button"
      className={`pill-switch${checked ? ' on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={() => onChange(!checked)}
    >
      <span className="pill-switch-text pill-switch-text-on">ON</span>
      <span className="pill-switch-text pill-switch-text-off">OFF</span>
      <span className="pill-switch-knob" />
    </button>
  );
}
