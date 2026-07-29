import { create } from 'zustand';

/** Accessibility preferences. Client-only (localStorage) this pass — not synced to the
 * server. Each setting maps to a data-attribute on <html>; CSS in tokens.css overrides
 * the design tokens off those attributes so the whole app responds. */

export type ColorblindMode = 'off' | 'deuteranopia' | 'protanopia' | 'tritanopia';
export type FontScale = 'normal' | 'large' | 'xlarge';
export type Contrast = 'normal' | 'high';

/** What a click-and-drag on the board does. 'navigate' is the historical behaviour (drag empty
 * space to pan); 'select' turns that same gesture into a marquee for selecting and moving
 * several tiles at once. Persisted like the other client-only preferences. */
export type BoardMode = 'navigate' | 'select';

interface SettingsState {
  colorblindMode: ColorblindMode;
  fontScale: FontScale;
  contrast: Contrast;
  /** Whether the client checks placed words against the dictionary at all — green tile tinting,
   * the "recall invalid tiles" tray action, and explanations for a rejected Plantains/Peel
   * attempt all depend on it. A personal preference (applies to every game this player is in,
   * not synced to a room), so it lives here alongside the other client-only settings rather than
   * in DictionaryConfig. Peel/Plantains still fire automatically either way, and the server still
   * authoritatively checks real words at Plantains time regardless of this setting. */
  wordValidationEnabled: boolean;
  /** Board drag behaviour — see BoardMode. Not a data-attribute like the a11y settings; the
   * board reads it directly. */
  boardMode: BoardMode;
  setColorblindMode: (m: ColorblindMode) => void;
  setFontScale: (s: FontScale) => void;
  setContrast: (c: Contrast) => void;
  setWordValidationEnabled: (enabled: boolean) => void;
  setBoardMode: (m: BoardMode) => void;
}

const KEYS = {
  colorblind: 'plantain-a11y-colorblind',
  fontScale: 'plantain-a11y-font-scale',
  contrast: 'plantain-a11y-contrast',
  wordValidation: 'plantain-word-validation-enabled',
  boardMode: 'plantain-board-mode',
} as const;

function read<T extends string>(key: string, fallback: T): T {
  return (localStorage.getItem(key) as T) ?? fallback;
}

function readBool(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  return raw === null ? fallback : raw === 'true';
}

/** Reflect the current settings onto <html> data-attributes so CSS can react. */
function applyToDocument(s: Pick<SettingsState, 'colorblindMode' | 'fontScale' | 'contrast'>) {
  const root = document.documentElement;
  root.dataset.colorblind = s.colorblindMode;
  root.dataset.fontScale = s.fontScale;
  root.dataset.contrast = s.contrast;
}

const initial = {
  colorblindMode: read<ColorblindMode>(KEYS.colorblind, 'off'),
  fontScale: read<FontScale>(KEYS.fontScale, 'normal'),
  contrast: read<Contrast>(KEYS.contrast, 'normal'),
  wordValidationEnabled: readBool(KEYS.wordValidation, true),
  // Defaults to the historical behaviour, so an existing player's board feels unchanged.
  boardMode: read<BoardMode>(KEYS.boardMode, 'navigate'),
};

// Apply persisted settings immediately at module load, before first paint of any screen.
applyToDocument(initial);

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...initial,
  setColorblindMode: (colorblindMode) => {
    localStorage.setItem(KEYS.colorblind, colorblindMode);
    set({ colorblindMode });
    applyToDocument({ ...get(), colorblindMode });
  },
  setFontScale: (fontScale) => {
    localStorage.setItem(KEYS.fontScale, fontScale);
    set({ fontScale });
    applyToDocument({ ...get(), fontScale });
  },
  setContrast: (contrast) => {
    localStorage.setItem(KEYS.contrast, contrast);
    set({ contrast });
    applyToDocument({ ...get(), contrast });
  },
  setWordValidationEnabled: (wordValidationEnabled) => {
    localStorage.setItem(KEYS.wordValidation, String(wordValidationEnabled));
    set({ wordValidationEnabled });
  },
  setBoardMode: (boardMode) => {
    localStorage.setItem(KEYS.boardMode, boardMode);
    set({ boardMode });
  },
}));
