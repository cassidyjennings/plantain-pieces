import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DEFAULT_DICTIONARY_CONFIG, BUNCH_SIZE_PRESETS, WORD_LENGTH_MAX, type DictionaryConfig } from '@plantain/shared';
import { api, ApiError } from '../lib/api.js';
import {
  fetchMyCustomWordSets,
  fetchMyDictionaryPresets,
  getDictionaryButtonLabel,
  type CustomWordSetSummary,
  type DictionaryPresetRow,
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

  const [dictConfig, setDictConfig] = useState<DictionaryConfig>(DEFAULT_DICTIONARY_CONFIG);
  const [mySets, setMySets] = useState<CustomWordSetSummary[]>([]);
  const [presets, setPresets] = useState<DictionaryPresetRow[]>([]);
  const [showWordlist, setShowWordlist] = useState(false);
  const [bunchSize, setBunchSize] = useState<number>(BUNCH_SIZE_PRESETS[1].size);
  const [timed, setTimed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMyCustomWordSets().then(setMySets);
    fetchMyDictionaryPresets().then(setPresets);
  }, []);

  function nameFor(id: string): string {
    return mySets.find((s) => s.id === id)?.name ?? 'Custom';
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
    <div className="centered">
      <h1 className="page-title">Play Solo!</h1>
      <p className="page-subtitle">Clear a Bunch all by yourself, at your own pace.</p>

      <div className="solo-setup-section">
        <h3>Pace</h3>
        <div className="toggle-group">
          <button
            type="button"
            className={`toggle-group-option${!timed ? ' selected' : ''}`}
            onClick={() => setTimed(false)}
          >
            Zen
          </button>
          <button
            type="button"
            className={`toggle-group-option${timed ? ' selected' : ''}`}
            onClick={() => setTimed(true)}
          >
            Timed
          </button>
        </div>
        <p className="hint">{timed ? 'Race to finish the bunch!' : 'No clock. Play at your own pace.'}</p>
      </div>

      <div className="solo-setup-section">
        <div className="wordlist-settings-row">
          <div className="wordlist-control">
            <span className="wordlist-control-label">Min. word length</span>
            <div className="wordlist-control-box">
              <WordLengthStepper
                value={dictConfig.minLength}
                maxValue={maxMinLength}
                onChange={(minLength) => setDictConfig({ ...dictConfig, minLength })}
              />
            </div>
          </div>
          <div className="wordlist-control">
            <span className="wordlist-control-label">Dictionaries</span>
            <div className="wordlist-control-box">
              <button type="button" className="dictionary-open-btn" onClick={() => setShowWordlist(true)}>
                {getDictionaryButtonLabel(dictConfig, nameFor, presets)}
              </button>
            </div>
          </div>
          <div className="wordlist-control">
            <span className="wordlist-control-label">Word validation</span>
            <div className="wordlist-control-box">
              <PillSwitch
                checked={wordValidationEnabled}
                onChange={setWordValidationEnabled}
                label="Word validation"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="solo-setup-section">
        <h3>Bunch size</h3>
        <div className="segmented">
          {BUNCH_SIZE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              className={`segmented-option${bunchSize === preset.size ? ' selected' : ''}`}
              onClick={() => setBunchSize(preset.size)}
            >
              {preset.label} ({preset.size})
            </button>
          ))}
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <button className="solo-start-btn" disabled={busy} onClick={handleStart}>
        {busy ? 'Starting…' : 'Start Solo Game'}
      </button>

      <button type="button" className="btn-leave" disabled={busy} onClick={() => navigate('/')}>
        ← Back to Menu
      </button>

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
