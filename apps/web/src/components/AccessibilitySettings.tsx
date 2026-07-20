import {
  useSettingsStore,
  type ColorblindMode,
  type FontScale,
  type Contrast,
} from '../store/settingsStore.js';

/** Accessibility controls. Each maps to a data-attribute on <html> that CSS reads (see
 * tokens.css). Client-only + persisted to localStorage via settingsStore. */

const COLORBLIND: { id: ColorblindMode; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'deuteranopia', label: 'Deuteranopia' },
  { id: 'protanopia', label: 'Protanopia' },
  { id: 'tritanopia', label: 'Tritanopia' },
];
const FONT: { id: FontScale; label: string }[] = [
  { id: 'normal', label: 'Normal' },
  { id: 'large', label: 'Large' },
  { id: 'xlarge', label: 'X-Large' },
];
const CONTRAST: { id: Contrast; label: string }[] = [
  { id: 'normal', label: 'Normal' },
  { id: 'high', label: 'High' },
];

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.id}
          className={`segmented-option${value === o.id ? ' selected' : ''}`}
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function AccessibilitySettings() {
  const { colorblindMode, fontScale, contrast, setColorblindMode, setFontScale, setContrast } =
    useSettingsStore();

  return (
    <div className="panel profile-panel">
      <div className="setting-row">
        <div className="setting-label">
          <strong>Colorblind-friendly tiles</strong>
          <span className="hint">Shifts tile and status colors to a safer palette.</span>
        </div>
        <Segmented value={colorblindMode} options={COLORBLIND} onChange={setColorblindMode} />
      </div>

      <div className="setting-row">
        <div className="setting-label">
          <strong>Font size</strong>
          <span className="hint">Scales text across the whole app.</span>
        </div>
        <Segmented value={fontScale} options={FONT} onChange={setFontScale} />
      </div>

      <div className="setting-row">
        <div className="setting-label">
          <strong>Contrast</strong>
          <span className="hint">Boosts borders and text contrast.</span>
        </div>
        <Segmented value={contrast} options={CONTRAST} onChange={setContrast} />
      </div>
    </div>
  );
}
