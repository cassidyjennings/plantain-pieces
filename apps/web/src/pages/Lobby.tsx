import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { fetchPlayers, fetchRoom, type PublicPlayer, type PublicRoom } from '../lib/rooms.js';
import { useRoomEvents } from '../hooks/useRoomEvents.js';
import { useSessionStore } from '../store/sessionStore.js';

export default function Lobby() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const profileId = useSessionStore((s) => s.profileId);
  const [room, setRoom] = useState<PublicRoom | null>(null);
  const [players, setPlayers] = useState<PublicPlayer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  useRoomEvents(roomId, () => {
    refresh();
  });

  const me = players.find((p) => p.profile_id === profileId);
  const isHost = room?.host_id === profileId;
  const activePlayers = players.filter((p) => !p.is_spectator);
  const allReady = activePlayers.length >= 2 && activePlayers.every((p) => p.is_ready);

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

  if (!room) return <div className="centered">Loading room...</div>;

  return (
    <div className="centered">
      <div className="panel">
        <h1>Room {room.code}</h1>
        <p className="hint">Share this code so friends can join.</p>

        <ul className="player-list">
          {players.map((p) => (
            <li key={p.profile_id}>
              {p.display_name}
              {p.profile_id === room.host_id ? ' (host)' : ''}
              {p.is_spectator ? ' (spectator)' : p.is_ready ? ' ✅ ready' : ' ⏳ not ready'}
            </li>
          ))}
        </ul>

        {me && !me.is_spectator && (
          <button disabled={busy} onClick={toggleReady}>
            {me.is_ready ? 'Not ready' : "I'm ready"}
          </button>
        )}

        {isHost && (
          <button disabled={busy || !allReady} onClick={handleStart}>
            Split! (start game)
          </button>
        )}
        {isHost && !allReady && (
          <p className="hint">Need 2+ players, all ready, to start.</p>
        )}

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
