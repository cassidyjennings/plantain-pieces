import { useEffect, useMemo, useState } from 'react';
import {
  validateDictionaryConfig,
  dictionaryConfigsEqual,
  MAX_PRESET_NAME_LENGTH,
  type DictionaryConfig,
} from '@plantain/shared';
import { api, ApiError } from '../lib/api.js';
import {
  fetchMyCustomWordSets,
  fetchMyDictionaryPresets,
  fetchOfficialWordSets,
  summarizeDictionaryConfig,
  type CustomWordSetSummary,
  type DictionaryPresetRow,
  type OfficialWordSet,
} from '../lib/dictionaries.js';
import DictionaryChecklist from './DictionaryChecklist.js';

interface WordlistModalProps {
  roomId: string;
  isHost: boolean;
  /** The room's currently active wordlist. */
  activeConfig: DictionaryConfig;
  onClose: () => void;
  onApplied?: (config: DictionaryConfig) => void;
}

/**
 * The room's wordlist: pick one or more dictionaries and a minimum word length. The host edits
 * and applies; everyone else sees what's in play read-only. Either way any player can save the
 * wordlist as their own preset — that's how you take a list you liked into your own games.
 */
export default function WordlistModal({
  roomId,
  isHost,
  activeConfig,
  onClose,
  onApplied,
}: WordlistModalProps) {
  const [draft, setDraft] = useState<DictionaryConfig>(activeConfig);
  const [mySets, setMySets] = useState<CustomWordSetSummary[]>([]);
  const [officialSets, setOfficialSets] = useState<OfficialWordSet[]>([]);
  const [presets, setPresets] = useState<DictionaryPresetRow[]>([]);
  const [roomSetNames, setRoomSetNames] = useState<Record<string, string>>({});
  const [presetName, setPresetName] = useState('');
  const [showSavePreset, setShowSavePreset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    fetchMyCustomWordSets().then(setMySets);
    fetchOfficialWordSets().then(setOfficialSets);
    fetchMyDictionaryPresets().then(setPresets);
  }, []);

  useEffect(() => {
    api
      .getRoomDictionarySetNames(roomId)
      .then(({ sets }) => setRoomSetNames(Object.fromEntries(sets.map((s) => [s.id, s.name]))))
      .catch(() => setRoomSetNames({}));
  }, [roomId]);

  // Official language dictionaries count as selectable for everyone, so they must be in here or
  // picking one would fail client-side validation and disable Apply.
  const selectableIds = useMemo(
    () => [...mySets.map((s) => s.id), ...officialSets.map((s) => s.id)],
    [mySets, officialSets],
  );
  const validity = useMemo(
    () => validateDictionaryConfig(draft, selectableIds),
    [draft, selectableIds],
  );
  const isDirty = JSON.stringify(draft) !== JSON.stringify(activeConfig);

  function nameFor(id: string): string {
    return (
      officialSets.find((s) => s.id === id)?.name ??
      mySets.find((s) => s.id === id)?.name ??
      roomSetNames[id] ??
      'Unknown dictionary'
    );
  }

  async function handleApply() {
    if (!validity.valid) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.setDictionaryConfig(roomId, draft);
      onApplied?.(result.config);
      setNotice('Applied to the game.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to apply the wordlist');
    } finally {
      setBusy(false);
    }
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
      const message = err instanceof ApiError ? err.message : 'Failed to save preset';
      // The wordlist can reference dictionaries owned by whoever set it up; you can't save a
      // preset pointing at word lists that aren't yours.
      setError(
        message === 'INVALID_CUSTOM_SET'
          ? "This wordlist uses dictionaries that aren't yours, so it can't be saved as your preset."
          : message,
      );
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
                {!isHost && (
                  <p className="hint journal-readonly-note">
                    Only the host can change the wordlist. Here's what's in play.
                  </p>
                )}

                {isHost && presets.length > 0 && (
                  <div className="journal-section">
                    <h3>Start from a preset</h3>
                    <div className="journal-chip-row">
                      {presets.map((preset) => {
                        const isActive = dictionaryConfigsEqual(preset.config, draft);
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            className={`journal-chip${isActive ? ' active' : ''}`}
                            aria-pressed={isActive}
                            onClick={() => setDraft(preset.config)}
                            disabled={busy}
                          >
                            {preset.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <DictionaryChecklist
                  config={draft}
                  onChange={setDraft}
                  mySets={mySets}
                  officialSets={officialSets}
                  readOnly={!isHost}
                  nameFor={nameFor}
                />

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
              {isHost && (
                <button
                  type="button"
                  disabled={busy || !validity.valid || !isDirty}
                  onClick={handleApply}
                >
                  {isDirty ? 'Apply to Game' : 'Applied'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
