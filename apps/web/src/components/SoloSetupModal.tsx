import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DEFAULT_DICTIONARY_CONFIG,
  validateDictionaryConfig,
  BUNCH_SIZE_PRESETS,
  type DictionaryConfig,
} from '@plantain/shared';
import { api, ApiError } from '../lib/api.js';
import { fetchMyCustomWordSets, type CustomWordSetSummary } from '../lib/dictionaries.js';
import WordlistEditor from './WordlistEditor.js';

interface SoloSetupModalProps {
  displayName: string;
  onClose: () => void;
}

/**
 * Pre-game setup for solo mode: dictionary, Bunch size, and Zen vs Timed. Unlike the multiplayer
 * WordlistModal, there's no room yet to attach the config to — WordlistEditor is embedded
 * directly (it only needs config/onChange/mySets, no roomId) and the chosen config is sent along
 * with the "start" call once the player hits Start.
 */
export default function SoloSetupModal({ displayName, onClose }: SoloSetupModalProps) {
  const navigate = useNavigate();
  const [dictConfig, setDictConfig] = useState<DictionaryConfig>(DEFAULT_DICTIONARY_CONFIG);
  const [mySets, setMySets] = useState<CustomWordSetSummary[]>([]);
  const [bunchSize, setBunchSize] = useState<number>(BUNCH_SIZE_PRESETS[1].size);
  const [timed, setTimed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMyCustomWordSets().then(setMySets);
  }, []);

  const ownedIds = useMemo(() => mySets.map((s) => s.id), [mySets]);
  const validity = useMemo(() => validateDictionaryConfig(dictConfig, ownedIds), [dictConfig, ownedIds]);

  function nameFor(id: string): string {
    return mySets.find((s) => s.id === id)?.name ?? 'Unknown dictionary';
  }

  async function handleStart() {
    if (!validity.valid) return;
    setBusy(true);
    setError(null);
    try {
      const room = await api.createSoloRoom(displayName, dictConfig, { bunchSize, timed });
      // The room is already active by the time this returns — skip the Lobby entirely.
      navigate(`/room/${room.roomId}/game`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start solo game');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card solo-setup-card"
        role="dialog"
        aria-modal="true"
        aria-label="Play Solo"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Play Solo</h2>
        <p className="hint">Clear a Bunch by yourself — pick your dictionary, size, and pace.</p>

        <WordlistEditor config={dictConfig} onChange={setDictConfig} mySets={mySets} nameFor={nameFor} />

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

        <div className="solo-setup-section">
          <h3>Pace</h3>
          <div className="segmented">
            <button
              className={`segmented-option${!timed ? ' selected' : ''}`}
              onClick={() => setTimed(false)}
            >
              Zen
            </button>
            <button
              className={`segmented-option${timed ? ' selected' : ''}`}
              onClick={() => setTimed(true)}
            >
              Timed
            </button>
          </div>
          <p className="hint">
            {timed ? 'A running clock shows while you play.' : "No clock — play at your own pace."}
          </p>
        </div>

        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button disabled={busy || !validity.valid} onClick={handleStart}>
            {busy ? 'Starting…' : 'Start Solo Game'}
          </button>
        </div>
      </div>
    </div>
  );
}
