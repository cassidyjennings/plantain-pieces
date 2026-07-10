import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { useSessionStore } from '../store/sessionStore.js';

export default function Home() {
  const navigate = useNavigate();
  const displayName = useSessionStore((s) => s.displayName);
  const setDisplayName = useSessionStore((s) => s.setDisplayName);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const name = displayName.trim() || 'Guest';

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      const room = await api.createRoom(name);
      navigate(`/room/${room.roomId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create room');
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin() {
    if (!joinCode.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const room = await api.joinRoom(joinCode.trim().toUpperCase(), name);
      navigate(`/room/${room.roomId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to join room');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="centered">
      <div className="panel">
        <h1>🍌 Plantain Pieces</h1>
        <label className="field">
          Display name
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Guest"
            maxLength={24}
          />
        </label>

        <button disabled={busy} onClick={handleCreate}>
          Create Room
        </button>

        <div className="join-row">
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            placeholder="Room code"
            maxLength={6}
          />
          <button disabled={busy || !joinCode.trim()} onClick={handleJoin}>
            Join
          </button>
        </div>

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
