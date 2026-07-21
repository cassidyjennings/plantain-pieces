import { useEffect, useMemo, useState } from 'react';
import { validateDictionaryConfig, MAX_PRESET_NAME_LENGTH, type DictionaryConfig } from '@plantain/shared';
import { api, ApiError } from '../lib/api.js';
import {
  fetchMyCustomWordSets,
  fetchMyDictionaryPresets,
  summarizeDictionaryConfig,
  type CustomWordSetSummary,
  type DictionaryPresetRow,
} from '../lib/dictionaries.js';
import DictionaryChecklist from './DictionaryChecklist.js';

interface SoloWordlistModalProps {
  config: DictionaryConfig;
  onApply: (config: DictionaryConfig) => void;
  onClose: () => void;
}

/**
 * The solo-setup equivalent of WordlistModal: there's no room yet to apply to, so "Apply" just
 * hands the edited config back to the caller's local state. Every set/preset here is the
 * player's own, so unlike the room version there's no read-only mode or room set-name lookup.
 */
export default function SoloWordlistModal({ config, onApply, onClose }: SoloWordlistModalProps) {
  const [draft, setDraft] = useState<DictionaryConfig>(config);
  const [mySets, setMySets] = useState<CustomWordSetSummary[]>([]);
  const [presets, setPresets] = useState<DictionaryPresetRow[]>([]);
  const [presetName, setPresetName] = useState('');
  const [showSavePreset, setShowSavePreset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    fetchMyCustomWordSets().then(setMySets);
    fetchMyDictionaryPresets().then(setPresets);
  }, []);

  const ownedIds = useMemo(() => mySets.map((s) => s.id), [mySets]);
  const validity = useMemo(() => validateDictionaryConfig(draft, ownedIds), [draft, ownedIds]);

  function nameFor(id: string): string {
    return mySets.find((s) => s.id === id)?.name ?? 'Unknown dictionary';
  }

  async function handleSaveAsPreset() {
    if (!presetName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.savePreset(presetName.trim(), draft);
      setPresets(await fetchMyDictionaryPresets());
      setPresetName('');
      setShowSavePreset(false);
      setNotice('Saved to your presets.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save preset');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="journal-backdrop" onClick={onClose}>
      <div className="journal-shell" onClick={(e) => e.stopPropagation()}>
        <div className="journal" role="dialog" aria-modal="true" aria-label="Choose Wordlist">
          <div className="journal-flip">
            <div className="journal-header">
              <h2>Choose Wordlist</h2>
              <button type="button" className="journal-close" onClick={onClose} aria-label="Close">
                ✕
              </button>
            </div>

            <div className="journal-page">
              <div className="journal-sheet">
                {presets.length > 0 && (
                  <div className="journal-section">
                    <h3>Start from a preset</h3>
                    <div className="journal-chip-row">
                      {presets.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          className="journal-chip"
                          onClick={() => setDraft(preset.config)}
                          disabled={busy}
                        >
                          {preset.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <DictionaryChecklist config={draft} onChange={setDraft} mySets={mySets} nameFor={nameFor} />

                {showSavePreset && (
                  <div className="journal-section">
                    <div className="journal-save-preset-row">
                      <input
                        value={presetName}
                        onChange={(e) => setPresetName(e.target.value)}
                        placeholder="Name this preset..."
                        maxLength={MAX_PRESET_NAME_LENGTH}
                      />
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={!presetName.trim() || busy}
                        onClick={handleSaveAsPreset}
                      >
                        Save
                      </button>
                    </div>
                    <p className="hint">Saves: {summarizeDictionaryConfig(draft, nameFor)}</p>
                  </div>
                )}

                {validity && !validity.valid && (
                  <p className="error">
                    {validity.reason === 'NO_WORD_SOURCE'
                      ? 'Pick at least one dictionary.'
                      : validity.reason.replace(/_/g, ' ').toLowerCase()}
                  </p>
                )}
                {error && <p className="error">{error}</p>}
                {notice && !error && <p className="hint">{notice}</p>}
              </div>
            </div>

            <div className="journal-footer wordlist-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowSavePreset((s) => !s)}
                disabled={busy}
              >
                Save as preset
              </button>
              <button
                type="button"
                disabled={busy || !validity.valid}
                onClick={() => {
                  onApply(draft);
                  onClose();
                }}
              >
                Use This Wordlist
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
