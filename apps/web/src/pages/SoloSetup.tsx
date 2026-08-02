import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DEFAULT_DICTIONARY_CONFIG, BUNCH_SIZE_PRESETS, WORD_LENGTH_MAX, type DictionaryConfig } from '@plantain/shared';
import { api, ApiError } from '../lib/api.js';
import {
  fetchMyCustomWordSets,
  fetchMyDictionaryPresets,
  fetchOfficialWordSets,
  getDictionaryButtonLabel,
  type CustomWordSetSummary,
  type DictionaryPresetRow,
  type OfficialWordSet,
} from '../lib/dictionaries.js';
import { useSessionStore } from '../store/sessionStore.js';
import { useSettingsStore } from '../store/settingsStore.js';
import SoloWordlistModal from '../components/SoloWordlistModal.js';
import PillSwitch from '../components/PillSwitch.js';
import WordLengthStepper from '../components/WordLengthStepper.js';

/**
 * Solo mode's pre-game setup, as a full page rather than a popup, mirroring the Lobby's own
 * flat, full-screen layout (no card wrappers) so solo and multiplayer feel like the same app.
 */
export default function SoloSetup() {
  const navigate = useNavigate();
  const displayName = useSessionStore((s) => s.displayName);
  const name = displayName.trim() || 'Guest';
  const wordValidationEnabled = useSettingsStore((s) => s.wordValidationEnabled);
  const setWordValidationEnabled = useSettingsStore((s) => s.setWordValidationEnabled);
  // Bunch size / Pace read and write straight through the settings store (same pattern as word
  // validation above), so the last-used setup is silently remembered between visits.
  const bunchSize = useSettingsStore((s) => s.soloBunchSize);
  const setBunchSize = useSettingsStore((s) => s.setSoloBunchSize);
  const timed = useSettingsStore((s) => s.soloTimed);
  const setTimed = useSettingsStore((s) => s.setSoloTimed);

  const [dictConfig, setDictConfig] = useState<DictionaryConfig>(DEFAULT_DICTIONARY_CONFIG);
  const [mySets, setMySets] = useState<CustomWordSetSummary[]>([]);
  const [officialSets, setOfficialSets] = useState<OfficialWordSet[]>([]);
  const [presets, setPresets] = useState<DictionaryPresetRow[]>([]);
  const [showWordlist, setShowWordlist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMyCustomWordSets().then(setMySets);
    fetchOfficialWordSets().then(setOfficialSets);
    fetchMyDictionaryPresets().then(setPresets);
  }, []);

  function nameFor(id: string): string {
    return (
      officialSets.find((s) => s.id === id)?.name ??
      mySets.find((s) => s.id === id)?.name ??
      'Custom'
    );
  }

  const maxMinLength = dictConfig.maxLength ?? WORD_LENGTH_MAX;

  async function handleStart() {
    setBusy(true);
    setError(null);
    try {
      const room = await api.createSoloRoom(name, dictConfig, { bunchSize, timed });
      // The room is already active by the time this returns, so skip a Lobby entirely.
      navigate(`/room/${room.roomId}/game`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start solo game');
      setBusy(false);
    }
  }

  return (
    <div className="centered solo-screen">
      <button type="button" className="solo-back" disabled={busy} onClick={() => navigate('/')}>
        ← <span className="solo-back-full">Back to </span>Menu
      </button>

      <h1 className="solo-title">Play Solo!</h1>

      <div className="solo-panel">
        <div className="solo-section">
          <span className="solo-section-label">Pace</span>
          <div className="tile-row">
            <button
              type="button"
              className={`choice-tile${!timed ? ' selected' : ''}`}
              onClick={() => setTimed(false)}
            >
              <span className="t">Zen</span>
              <span className="s">No clock</span>
            </button>
            <button
              type="button"
              className={`choice-tile${timed ? ' selected' : ''}`}
              onClick={() => setTimed(true)}
            >
              <span className="t">Timed</span>
              <span className="s">Against the clock</span>
            </button>
          </div>
        </div>

        <div className="solo-section">
          <span className="solo-section-label">Bunch size</span>
          <div className="tile-row">
            {BUNCH_SIZE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={`choice-tile${bunchSize === preset.size ? ' selected' : ''}`}
                onClick={() => setBunchSize(preset.size)}
              >
                <span className="t">{preset.label}</span>
                <span className="s">{preset.size} tiles</span>
              </button>
            ))}
          </div>
        </div>

        <div className="solo-rules">
          <div className="solo-rule">
            <span className="solo-rule-label">Min. word length</span>
            <div className="solo-rule-box stepper">
              <WordLengthStepper
                value={dictConfig.minLength}
                maxValue={maxMinLength}
                onChange={(minLength) => setDictConfig({ ...dictConfig, minLength })}
              />
            </div>
          </div>
          <div className="solo-rule">
            <span className="solo-rule-label">Dictionaries</span>
            <div className="solo-rule-box">
              <button type="button" className="dictionary-open-btn" onClick={() => setShowWordlist(true)}>
                {getDictionaryButtonLabel(dictConfig, nameFor, presets)}
              </button>
            </div>
          </div>
          <div className="solo-rule">
            <span className="solo-rule-label">Word validation</span>
            <div className="solo-rule-box switch">
              <PillSwitch
                checked={wordValidationEnabled}
                onChange={setWordValidationEnabled}
                label="Word validation"
              />
            </div>
          </div>
        </div>

        {error && <p className="error">{error}</p>}

        <button className="btn-split" disabled={busy} onClick={handleStart}>
          {busy ? 'Splitting…' : 'Split!'}
        </button>
      </div>

      {showWordlist && (
        <SoloWordlistModal
          config={dictConfig}
          onApply={setDictConfig}
          onClose={() => setShowWordlist(false)}
        />
      )}
    </div>
  );
}
