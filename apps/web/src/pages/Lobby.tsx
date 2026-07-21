import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { WORD_LENGTH_MAX } from '@plantain/shared';
import { api, ApiError } from '../lib/api.js';
import { fetchPlayers, fetchRoom, type PublicPlayer, type PublicRoom } from '../lib/rooms.js';
import { fetchMyDictionaryPresets, getDictionaryButtonLabel, type DictionaryPresetRow } from '../lib/dictionaries.js';
import { useRoomEvents } from '../hooks/useRoomEvents.js';
import { useSessionStore } from '../store/sessionStore.js';
import { useSettingsStore } from '../store/settingsStore.js';
import WordlistModal from '../components/WordlistModal.js';
import Avatar from '../components/Avatar.js';
import PillSwitch from '../components/PillSwitch.js';
import WordLengthStepper from '../components/WordLengthStepper.js';

export default function Lobby() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const profileId = useSessionStore((s) => s.profileId);
  const [room, setRoom] = useState<PublicRoom | null>(null);
  const [players, setPlayers] = useState<PublicPlayer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showJournal, setShowJournal] = useState(false);
  const [pulseKey, setPulseKey] = useState(0);
  const [setNames, setSetNames] = useState<Record<string, string>>({});
  const [presets, setPresets] = useState<DictionaryPresetRow[]>([]);
  const wordValidationEnabled = useSettingsStore((s) => s.wordValidationEnabled);
  const setWordValidationEnabled = useSettingsStore((s) => s.setWordValidationEnabled);

  useEffect(() => {
    fetchMyDictionaryPresets().then(setPresets);
  }, []);

  const refresh = useCallback(async () => {
    if (!roomId) return;
    const [r, p] = await Promise.all([fetchRoom(roomId), fetchPlayers(roomId)]);
    setRoom(r);
    setPlayers(p);
    if (r?.status === 'active') navigate(`/room/${roomId}/game`, { replace: true });
    if (r?.status === 'finished') navigate(`/room/${roomId}/results`, { replace: true });
  }, [roomId, navigate]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** The config only carries set ids, and the host's dictionaries are RLS-private to them, so
   * the summary chip needs the Worker to resolve the names it's allowed to show. */
  const refreshSetNames = useCallback(async () => {
    if (!roomId) return;
    try {
      const { sets } = await api.getRoomDictionarySetNames(roomId);
      setSetNames(Object.fromEntries(sets.map((s) => [s.id, s.name])));
    } catch {
      setSetNames({});
    }
  }, [roomId]);

  useEffect(() => {
    refreshSetNames();
  }, [refreshSetNames]);

  useRoomEvents(roomId, (event) => {
    if (event.type === 'dictionary_config_changed') {
      setPulseKey((k) => k + 1);
      refreshSetNames();
    }
    refresh();
  });

  const me = players.find((p) => p.profile_id === profileId);
  const isHost = room?.host_id === profileId;
  const activePlayers = players.filter((p) => !p.is_spectator);
  // Solo play is allowed: one ready player can Split. The server-side minimum is also 1
  // (migration 20260720000002); keep these in sync.
  const allReady = activePlayers.length >= 1 && activePlayers.every((p) => p.is_ready);

  async function toggleReady() {
    if (!roomId || !me) return;
    setBusy(true);
    setError(null);
    try {
      await api.setReady(roomId, !me.is_ready);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update ready state');
    } finally {
      setBusy(false);
    }
  }

  async function handleStart() {
    if (!roomId) return;
    setBusy(true);
    setError(null);
    try {
      await api.startGame(roomId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start game');
    } finally {
      setBusy(false);
    }
  }

  async function handleMinLengthChange(minLength: number) {
    if (!roomId || !room || !isHost) return;
    try {
      const result = await api.setDictionaryConfig(roomId, { ...room.dictionary_config, minLength });
      setRoom((r) => (r ? { ...r, dictionary_config: result.config } : r));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update word length');
    }
  }

  async function handleLeave() {
    if (!roomId) return;
    setBusy(true);
    try {
      await api.leaveRoom(roomId);
    } catch {
      // Even if the server call fails (e.g. already removed), still exit the screen.
    }
    navigate('/', { replace: true });
  }

  if (!room) return <div className="centered">Loading room...</div>;

  return (
    <div className="centered">
      <div className="room-code-pill">
        <span className="label">ROOM CODE</span>
        <span className="code">{room.code}</span>
      </div>
      <p className="hint">Share this code so friends can join.</p>

      <div className="solo-setup-section">
        <div className="wordlist-settings-row">
          <div className="wordlist-control">
            <span className="wordlist-control-label">Min. word length</span>
            <div className="wordlist-control-box">
              <WordLengthStepper
                value={room.dictionary_config.minLength}
                maxValue={room.dictionary_config.maxLength ?? WORD_LENGTH_MAX}
                onChange={handleMinLengthChange}
                disabled={!isHost}
              />
            </div>
          </div>
          <div className="wordlist-control">
            <span className="wordlist-control-label">Dictionaries</span>
            <div className="wordlist-control-box">
              <button
                key={pulseKey}
                type="button"
                className={`dictionary-open-btn${pulseKey > 0 ? ' pulse' : ''}`}
                onClick={() => setShowJournal(true)}
              >
                {getDictionaryButtonLabel(room.dictionary_config, (id) => setNames[id] ?? 'Custom', presets)}
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

      <div className="player-grid">
        {players.map((p) => {
          const isPlayerHost = p.profile_id === room.host_id;
          return (
            <div key={p.profile_id} className={`player-card${isPlayerHost ? ' host' : ''}`}>
              <Avatar config={p.avatar_config} size={52} />
              <span className="player-name">{p.display_name}</span>
              {isPlayerHost && <span className="player-host-tag">Host</span>}
              {p.is_spectator ? (
                <span className="player-ready">Spectator</span>
              ) : (
                <span className={`player-ready ${p.is_ready ? 'ready' : 'waiting'}`}>
                  {p.is_ready ? 'Ready' : 'Waiting'}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {me && !me.is_spectator && (
        <button disabled={busy} onClick={toggleReady}>
          {me.is_ready ? 'Not ready' : "I'm ready"}
        </button>
      )}

      {isHost && (
        <button disabled={busy || !allReady} onClick={handleStart}>
          Split!
        </button>
      )}
      {isHost && !allReady && <p className="hint">Everyone needs to be ready to start.</p>}

      <button type="button" className="btn-leave" disabled={busy} onClick={handleLeave}>
        ← Leave Room
      </button>

      {error && <p className="error">{error}</p>}

      {showJournal && roomId && (
        <WordlistModal
          roomId={roomId}
          isHost={isHost}
          activeConfig={room.dictionary_config}
          onClose={() => setShowJournal(false)}
          onApplied={() => refresh()}
        />
      )}
    </div>
  );
}
