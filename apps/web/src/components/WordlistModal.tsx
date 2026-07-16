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
import WordlistEditor from './WordlistEditor.js';

interface WordlistModalProps {
  roomId: string;
  isHost: boolean;
  /** The room's currently active wordlist. */
  activeConfig: DictionaryConfig;
  onClose: () => void;
  onApplied?: (config: DictionaryConfig) => void;
}

/**
 * The room's wordlist: pick a base dictionary and optionally add more. The host edits and
 * applies; everyone else sees what's in play read-only. Either way any player can save the
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
  const [presets, setPresets] = useState<DictionaryPresetRow[]>([]);
  const [roomSetNames, setRoomSetNames] = useState<Record<string, string>>({});
  const [presetName, setPresetName] = useState('');
  const [showSavePreset, setShowSavePreset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    fetchMyCustomWordSets().then(setMySets);
    fetchMyDictionaryPresets().then(setPresets);
  }, []);

  useEffect(() => {
    api
      .getRoomDictionarySetNames(roomId)
      .then(({ sets }) => setRoomSetNames(Object.fromEntries(sets.map((s) => [s.id, s.name]))))
      .catch(() => setRoomSetNames({}));
  }, [roomId]);

  const ownedIds = useMemo(() => mySets.map((s) => s.id), [mySets]);
  const validity = useMemo(() => validateDictionaryConfig(draft, ownedIds), [draft, ownedIds]);
  const isDirty = JSON.stringify(draft) !== JSON.stringify(activeConfig);

  function nameFor(id: string): string {
    return mySets.find((s) => s.id === id)?.name ?? roomSetNames[id] ?? 'Unknown dictionary';
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
                    Only the host can change the wordlist — here's what's in play.
                  </p>
                )}

                {isHost && presets.length > 0 && (
                  <div className="journal-section">
                    <h3>Start from a preset</h3>
                    <div className="journal-chip-row">
                      {presets.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          className="journal-chip"
                          onClick={() => setDraft({ ...preset.config, minLength: draft.minLength, maxLength: draft.maxLength })}
                          disabled={busy}
                        >
                          {preset.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <WordlistEditor
                  config={draft}
                  onChange={setDraft}
                  mySets={mySets}
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
                  {isDirty ? 'Apply to Game' : 'Applied ✓'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
