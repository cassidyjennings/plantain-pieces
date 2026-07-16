import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { fetchPlayers, fetchRoom, type PublicPlayer, type PublicRoom } from '../lib/rooms.js';
import { summarizeDictionaryConfig } from '../lib/dictionaries.js';
import { useRoomEvents } from '../hooks/useRoomEvents.js';
import { useSessionStore } from '../store/sessionStore.js';
import DictionaryJournal from '../components/DictionaryJournal.js';

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

  useRoomEvents(roomId, (event) => {
    if (event.type === 'dictionary_config_changed') setPulseKey((k) => k + 1);
    refresh();
  });

  const me = players.find((p) => p.profile_id === profileId);
  const isHost = room?.host_id === profileId;
  const activePlayers = players.filter((p) => !p.is_spectator);
  // TEMP: relaxed from >= 2 to >= 1 for solo dev testing. Revert before real multiplayer use —
  // the server-side minimum was patched the same way (runtime-only, not migrated) so a
  // `db:reset` will restore the real 2-player rule; this client check needs reverting by hand.
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

      <div className="dictionary-summary-row">
        <span key={pulseKey} className={`dictionary-summary-chip${pulseKey > 0 ? ' pulse' : ''}`}>
          {summarizeDictionaryConfig(room.dictionary_config)}
        </span>
        <button type="button" className="dictionary-open-btn" onClick={() => setShowJournal(true)}>
          {isHost ? 'Edit Dictionaries' : 'Dictionaries'}
        </button>
      </div>

      <div className="player-grid">
        {players.map((p) => {
          const isPlayerHost = p.profile_id === room.host_id;
          return (
            <div key={p.profile_id} className={`player-card${isPlayerHost ? ' host' : ''}`}>
              <div className="player-avatar">{p.display_name.charAt(0).toUpperCase()}</div>
              <span className="player-name">{p.display_name}</span>
              {isPlayerHost && <span className="player-host-tag">Host</span>}
              {p.is_spectator ? (
                <span className="player-ready">Spectator</span>
              ) : (
                <span className={`player-ready ${p.is_ready ? 'ready' : 'waiting'}`}>
                  {p.is_ready ? '✅ Ready' : '⏳ Waiting'}
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
          Split! 🍌
        </button>
      )}
      {isHost && !allReady && <p className="hint">Need 2+ players, all ready, to start.</p>}

      <button type="button" className="btn-leave" disabled={busy} onClick={handleLeave}>
        ← Leave Room
      </button>

      {error && <p className="error">{error}</p>}

      {showJournal && roomId && (
        <DictionaryJournal
          mode="room"
          roomId={roomId}
          isHost={isHost}
          activeConfig={room.dictionary_config}
          onClose={() => setShowJournal(false)}
          onConfigApplied={() => refresh()}
        />
      )}
    </div>
  );
}
