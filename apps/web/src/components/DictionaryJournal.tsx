import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_DICTIONARY_CONFIG,
  validateDictionaryConfig,
  MAX_PRESET_NAME_LENGTH,
  type DictionaryConfig,
} from '@plantain/shared';
import { api, ApiError } from '../lib/api.js';
import {
  ENGLISH_BASE_LABEL,
  fetchMyCustomWordSets,
  fetchMyDictionaryPresets,
  fetchCustomWordSetWords,
  summarizeDictionaryConfig,
  type CustomWordSetSummary,
  type DictionaryPresetRow,
} from '../lib/dictionaries.js';
import WordSetEditor from './WordSetEditor.js';
import WordlistEditor from './WordlistEditor.js';

type Tab = 'dicts' | 'presets';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dicts', label: 'Dictionaries' },
  { id: 'presets', label: 'Presets' },
];

interface DictionaryJournalProps {
  onClose: () => void;
}

/**
 * Your dictionary shelf: write word lists, and save presets (named base + extras combos) to
 * reuse in future games. Word length is deliberately absent — it's a per-game setting the host
 * controls in-game, not a property of a dictionary.
 */
export default function DictionaryJournal({ onClose }: DictionaryJournalProps) {
  const [tab, setTab] = useState<Tab>('dicts');
  const [mySets, setMySets] = useState<CustomWordSetSummary[]>([]);
  const [presets, setPresets] = useState<DictionaryPresetRow[]>([]);
  const [editingSet, setEditingSet] = useState<{ id: string | null; name: string; words: string[] } | null>(
    null,
  );
  const [editingPreset, setEditingPreset] = useState<{ name: string; config: DictionaryConfig } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMyCustomWordSets().then(setMySets);
    fetchMyDictionaryPresets().then(setPresets);
  }, []);

  const ownedIds = useMemo(() => mySets.map((s) => s.id), [mySets]);

  function nameFor(id: string): string {
    return mySets.find((s) => s.id === id)?.name ?? 'Unknown dictionary';
  }

  async function refreshMySets() {
    setMySets(await fetchMyCustomWordSets());
  }

  async function refreshPresets() {
    setPresets(await fetchMyDictionaryPresets());
  }

  async function openEditSetEditor(set: CustomWordSetSummary) {
    setBusy(true);
    const words = await fetchCustomWordSetWords(set.id);
    setBusy(false);
    setEditingSet({ id: set.id, name: set.name, words });
  }

  async function handleSaveSet(name: string, words: string[]) {
    setBusy(true);
    setError(null);
    try {
      if (editingSet?.id) {
        await api.updateWordSet(editingSet.id, name, words);
      } else {
        await api.createWordSet(name, words);
      }
      await refreshMySets();
      setEditingSet(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save dictionary');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteSet(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.deleteWordSet(id);
      await refreshMySets();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete dictionary');
    } finally {
      setBusy(false);
    }
  }

  async function handleSavePreset() {
    if (!editingPreset || !editingPreset.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.savePreset(editingPreset.name.trim(), editingPreset.config);
      await refreshPresets();
      setEditingPreset(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save preset');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeletePreset(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.deletePreset(id);
      await refreshPresets();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete preset');
    } finally {
      setBusy(false);
    }
  }

  const presetValidity = editingPreset
    ? validateDictionaryConfig(editingPreset.config, ownedIds)
    : null;
  const title = editingPreset ? 'Preset' : TABS.find((t) => t.id === tab)!.label;

  return (
    <div className="journal-backdrop" onClick={onClose}>
      <div className="journal-shell" onClick={(e) => e.stopPropagation()}>
        <div className="journal-tabs" role="tablist" aria-label="Dictionary sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`journal-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => {
                setTab(t.id);
                setEditingSet(null);
                setEditingPreset(null);
                setError(null);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="journal" role="dialog" aria-modal="true" aria-label="Dictionaries">
          <div className="journal-flip">
            <div className="journal-header">
              <h2>{title}</h2>
              <button type="button" className="journal-close" onClick={onClose} aria-label="Close">
                ✕
              </button>
            </div>

            <div className="journal-page">
              <div className="journal-sheet">
                {tab === 'dicts' && (
                  <div className="journal-section">
                    {editingSet ? (
                      <WordSetEditor
                        initialName={editingSet.name}
                        initialWords={editingSet.words}
                        busy={busy}
                        error={error}
                        onCancel={() => setEditingSet(null)}
                        onSave={handleSaveSet}
                      />
                    ) : (
                      <>
                        <h3>Built in</h3>
                        <ul className="journal-set-list">
                          <li className="journal-set-row">
                            <span className="journal-set-name">{ENGLISH_BASE_LABEL}</span>
                            <span className="journal-set-count">ENABLE1 · ~172,000 words</span>
                          </li>
                        </ul>

                        <h3>Your dictionaries</h3>
                        {mySets.length === 0 && (
                          <p className="hint">Nothing here yet — write your own word list below.</p>
                        )}
                        <ul className="journal-set-list">
                          {mySets.map((set) => (
                            <li key={set.id} className="journal-set-row">
                              <span className="journal-set-name">{set.name}</span>
                              <span className="journal-set-count">{set.word_count} words</span>
                              <button
                                type="button"
                                className="journal-icon-btn"
                                onClick={() => openEditSetEditor(set)}
                                disabled={busy}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="journal-icon-btn danger"
                                aria-label={`Delete ${set.name}`}
                                onClick={() => handleDeleteSet(set.id)}
                                disabled={busy}
                              >
                                ✕
                              </button>
                            </li>
                          ))}
                        </ul>
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => setEditingSet({ id: null, name: '', words: [] })}
                        >
                          + New Dictionary
                        </button>
                      </>
                    )}
                  </div>
                )}

                {tab === 'presets' && !editingPreset && (
                  <div className="journal-section">
                    <p className="hint journal-preset-blurb">
                      Save custom combinations of dictionaries to reuse.
                    </p>
                    {presets.length === 0 && <p className="hint">No saved presets yet.</p>}
                    <ul className="journal-set-list">
                      {presets.map((preset) => (
                        <li key={preset.id} className="journal-set-row">
                          <span className="journal-set-name">{preset.name}</span>
                          <span className="journal-set-count">
                            {summarizeDictionaryConfig(preset.config, nameFor)}
                          </span>
                          <button
                            type="button"
                            className="journal-icon-btn"
                            onClick={() =>
                              setEditingPreset({ name: preset.name, config: preset.config })
                            }
                            disabled={busy}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="journal-icon-btn danger"
                            aria-label={`Delete ${preset.name}`}
                            onClick={() => handleDeletePreset(preset.id)}
                            disabled={busy}
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() =>
                        setEditingPreset({ name: '', config: { ...DEFAULT_DICTIONARY_CONFIG } })
                      }
                    >
                      + New Preset
                    </button>
                  </div>
                )}

                {tab === 'presets' && editingPreset && (
                  <div className="journal-section">
                    <label className="field">
                      Preset name
                      <input
                        value={editingPreset.name}
                        onChange={(e) =>
                          setEditingPreset({ ...editingPreset, name: e.target.value })
                        }
                        placeholder="e.g. Family Game Night"
                        maxLength={MAX_PRESET_NAME_LENGTH}
                      />
                    </label>

                    <WordlistEditor
                      config={editingPreset.config}
                      onChange={(config) => setEditingPreset({ ...editingPreset, config })}
                      mySets={mySets}
                      nameFor={nameFor}
                    />

                    {presetValidity && !presetValidity.valid && (
                      <p className="error">
                        {presetValidity.reason === 'NO_WORD_SOURCE'
                          ? 'Pick a base dictionary.'
                          : presetValidity.reason.replace(/_/g, ' ').toLowerCase()}
                      </p>
                    )}
                    {error && <p className="error">{error}</p>}

                    <div className="word-set-editor-actions">
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => setEditingPreset(null)}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={busy || !editingPreset.name.trim() || !presetValidity?.valid}
                        onClick={handleSavePreset}
                      >
                        Save Preset
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {error && !editingSet && !editingPreset && (
              <p className="error journal-footer-note">{error}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
