import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_DICTIONARY_CONFIG,
  validateDictionaryConfig,
  MAX_PRESET_NAME_LENGTH,
  type DictionaryConfig,
} from '@plantain/shared';
import { api, ApiError } from '../lib/api.js';
import {
  fetchMyCustomWordSets,
  fetchMyDictionaryPresets,
  fetchCustomWordSetWords,
  summarizeDictionaryConfig,
  type CustomWordSetSummary,
  type DictionaryPresetRow,
} from '../lib/dictionaries.js';
import WordSetEditor from './WordSetEditor.js';

type Tab = 'dicts' | 'length' | 'presets';

interface DictionaryJournalProps {
  /** "room": editing/viewing a specific room's active config (host can apply, everyone
   * can still manage their own dictionaries/presets). "standalone": no room in context —
   * build dictionaries and presets from Home for future games. */
  mode: 'room' | 'standalone';
  roomId?: string;
  isHost?: boolean;
  activeConfig?: DictionaryConfig;
  onClose: () => void;
  /** Fired after a successful Apply — caller can optimistically update its own room state
   * instead of waiting for the next realtime refresh. */
  onConfigApplied?: (config: DictionaryConfig) => void;
}

const LENGTH_CHOICES = [2, 3, 4, 5];

export default function DictionaryJournal({
  mode,
  roomId,
  isHost = false,
  activeConfig,
  onClose,
  onConfigApplied,
}: DictionaryJournalProps) {
  const [tab, setTab] = useState<Tab>('dicts');
  const [draft, setDraft] = useState<DictionaryConfig>(activeConfig ?? DEFAULT_DICTIONARY_CONFIG);
  const [mySets, setMySets] = useState<CustomWordSetSummary[]>([]);
  const [presets, setPresets] = useState<DictionaryPresetRow[]>([]);
  const [roomSetNames, setRoomSetNames] = useState<Record<string, string>>({});
  const [editingSet, setEditingSet] = useState<{ id: string | null; name: string; words: string[] } | null>(
    null,
  );
  const [presetName, setPresetName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Room mode: only the host edits the room's active setup; everyone else sees it
  // read-only. Standalone mode: the draft is a scratchpad for building presets, so
  // everything is editable.
  const canEditDraft = mode === 'standalone' || isHost;
  const isRoomReadOnly = mode === 'room' && !isHost;

  useEffect(() => {
    fetchMyCustomWordSets().then(setMySets);
    fetchMyDictionaryPresets().then(setPresets);
  }, []);

  useEffect(() => {
    if (mode !== 'room' || !roomId) return;
    api
      .getRoomDictionarySetNames(roomId)
      .then(({ sets }) => setRoomSetNames(Object.fromEntries(sets.map((s) => [s.id, s.name]))))
      .catch(() => setRoomSetNames({}));
  }, [mode, roomId]);

  const ownedIds = useMemo(() => mySets.map((s) => s.id), [mySets]);
  const validity = useMemo(() => validateDictionaryConfig(draft, ownedIds), [draft, ownedIds]);
  const isDirty = JSON.stringify(draft) !== JSON.stringify(activeConfig ?? DEFAULT_DICTIONARY_CONFIG);

  function setName(id: string): string {
    return mySets.find((s) => s.id === id)?.name ?? roomSetNames[id] ?? 'Unknown dictionary';
  }

  async function refreshMySets() {
    setMySets(await fetchMyCustomWordSets());
  }

  async function refreshPresets() {
    setPresets(await fetchMyDictionaryPresets());
  }

  function toggleCustomSet(id: string) {
    setDraft((d) => ({
      ...d,
      customSetIds: d.customSetIds.includes(id)
        ? d.customSetIds.filter((x) => x !== id)
        : [...d.customSetIds, id],
    }));
  }

  async function handleApply() {
    if (!roomId || !validity.valid) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.setDictionaryConfig(roomId, draft);
      onConfigApplied?.(result.config);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to apply dictionary settings');
    } finally {
      setBusy(false);
    }
  }

  function openNewSetEditor() {
    setEditingSet({ id: null, name: '', words: [] });
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
      setDraft((d) => ({ ...d, customSetIds: d.customSetIds.filter((x) => x !== id) }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete dictionary');
    } finally {
      setBusy(false);
    }
  }

  async function handleSavePreset() {
    if (!presetName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.savePreset(presetName.trim(), draft);
      await refreshPresets();
      setPresetName('');
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

  const tabs: { id: Tab; label: string }[] = [
    { id: 'dicts', label: 'Dictionaries' },
    { id: 'length', label: 'Word Length' },
    { id: 'presets', label: 'Presets' },
  ];

  return (
    <div className="journal-backdrop" onClick={onClose}>
      <div className="journal-shell" onClick={(e) => e.stopPropagation()}>
        <div className="journal-tabs" role="tablist" aria-label="Dictionary sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`journal-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="journal" role="dialog" aria-modal="true" aria-label="Dictionaries">
          {/* The whole page — header title, body, footer — flips top-down on tab change.
              Keyed by tab so switching remounts this wrapper and replays the flip. */}
          <div className="journal-flip" key={tab}>
            <div className="journal-header">
              <h2>Dictionaries</h2>
              <button type="button" className="journal-close" onClick={onClose} aria-label="Close">
                ✕
              </button>
            </div>

            <div className="journal-page">
              <div className="journal-sheet">
              {isRoomReadOnly && tab !== 'presets' && !editingSet && (
                <p className="hint journal-readonly-note">
                  Only the host can change this game's setup — here's what's active.
                </p>
              )}

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
                      <h3>Base word lists</h3>
                      <ul className="journal-set-list">
                        <li className="journal-set-row base-row">
                          <input
                            type="checkbox"
                            checked={draft.baseEnabled}
                            disabled={!canEditDraft}
                            onChange={(e) => setDraft((d) => ({ ...d, baseEnabled: e.target.checked }))}
                            aria-label="Include the standard English word list"
                          />
                          <span className="journal-set-name">English</span>
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
                            <input
                              type="checkbox"
                              checked={draft.customSetIds.includes(set.id)}
                              disabled={!canEditDraft}
                              onChange={() => toggleCustomSet(set.id)}
                              aria-label={`Include ${set.name}`}
                            />
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
                      <button type="button" className="btn-secondary" onClick={openNewSetEditor}>
                        + New Dictionary
                      </button>
                      {!validity.valid && validity.reason === 'NO_WORD_SOURCE' && (
                        <p className="error">Keep the English list on, or check at least one dictionary.</p>
                      )}
                    </>
                  )}
                </div>
              )}

              {tab === 'length' && (
                <div className="journal-section">
                  <h3>Shortest word allowed</h3>
                  <div className="journal-chip-row">
                    {LENGTH_CHOICES.map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`journal-chip${draft.minLength === n ? ' active' : ''}`}
                        disabled={!canEditDraft}
                        onClick={() => setDraft((d) => ({ ...d, minLength: n }))}
                      >
                        {n}+ letters
                      </button>
                    ))}
                  </div>

                  <h3>Longest word allowed</h3>
                  <div className="journal-chip-row">
                    <button
                      type="button"
                      className={`journal-chip${draft.maxLength === null ? ' active' : ''}`}
                      disabled={!canEditDraft}
                      onClick={() => setDraft((d) => ({ ...d, maxLength: null }))}
                    >
                      No limit
                    </button>
                    <button
                      type="button"
                      className={`journal-chip${draft.maxLength !== null ? ' active' : ''}`}
                      disabled={!canEditDraft}
                      onClick={() => setDraft((d) => ({ ...d, maxLength: d.maxLength ?? 8 }))}
                    >
                      Cap it
                    </button>
                    {draft.maxLength !== null && (
                      <input
                        className="journal-number"
                        type="number"
                        min={draft.minLength}
                        max={24}
                        value={draft.maxLength}
                        disabled={!canEditDraft}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            maxLength: Math.max(d.minLength, Number(e.target.value) || d.minLength),
                          }))
                        }
                      />
                    )}
                  </div>
                </div>
              )}

              {tab === 'presets' && (
                <div className="journal-section">
                  <p className="hint journal-preset-blurb">
                    A preset is a named combo of dictionaries and settings, ready to reuse in any game.
                  </p>
                  {presets.length === 0 && <p className="hint">No saved presets yet.</p>}
                  <ul className="journal-set-list">
                    {presets.map((preset) => (
                      <li key={preset.id} className="journal-set-row">
                        <span className="journal-set-name">{preset.name}</span>
                        <span className="journal-set-count">{summarizeDictionaryConfig(preset.config)}</span>
                        {canEditDraft && (
                          <button
                            type="button"
                            className="journal-icon-btn"
                            onClick={() => setDraft(preset.config)}
                            disabled={busy}
                          >
                            Use
                          </button>
                        )}
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

                  <div className="journal-save-preset-row">
                    <input
                      value={presetName}
                      onChange={(e) => setPresetName(e.target.value)}
                      placeholder="Name this combo..."
                      maxLength={MAX_PRESET_NAME_LENGTH}
                    />
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={!presetName.trim() || !validity.valid || busy}
                      onClick={handleSavePreset}
                    >
                      Save preset
                    </button>
                  </div>
                  <p className="hint">Saves the current setup: {summarizeDictionaryConfig(draft)}</p>
                </div>
              )}
            </div>
          </div>

          {tab !== 'dicts' && draft.customSetIds.length > 0 && (
            <p className="hint journal-footer-note">Custom: {draft.customSetIds.map(setName).join(', ')}</p>
          )}

          {error && !editingSet && <p className="error journal-footer-note">{error}</p>}

          {mode === 'room' && isHost && (
            <div className="journal-footer">
              {!validity.valid && (
                <p className="error">{validity.reason?.replace(/_/g, ' ').toLowerCase()}</p>
              )}
              <button type="button" disabled={busy || !validity.valid || !isDirty} onClick={handleApply}>
                {isDirty ? 'Apply to Room' : 'Applied ✓'}
              </button>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
