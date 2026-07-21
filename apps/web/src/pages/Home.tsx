import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { validateDisplayName } from '@plantain/shared';
import { api, ApiError } from '../lib/api.js';
import { useSessionStore } from '../store/sessionStore.js';
import Logo from '../components/Logo.js';
import Avatar from '../components/Avatar.js';
import DictionaryJournal from '../components/DictionaryJournal.js';

export default function Home() {
  const navigate = useNavigate();
  const displayName = useSessionStore((s) => s.displayName);
  const setDisplayName = useSessionStore((s) => s.setDisplayName);
  const avatarConfig = useSessionStore((s) => s.avatarConfig);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showJournal, setShowJournal] = useState(false);

  const name = displayName.trim() || 'Guest';

  /** Persist the typed name to the account (fire-and-forget) so it survives across
   * sessions/devices — the natural commit point is entering a game. */
  function persistName() {
    if (validateDisplayName(name).valid) {
      api.updateProfile({ displayName: name }).catch(() => {});
    }
  }

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      persistName();
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
      persistName();
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
      <div className="home-header">
        <Logo size={120} sway />
        <h1 className="wordmark">
          PLANTAIN
          <span className="accent-line">PIECES</span>
        </h1>
      </div>

      <div className="panel">
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
          <button className="btn-secondary" disabled={busy || !joinCode.trim()} onClick={handleJoin}>
            Join
          </button>
        </div>

        {error && <p className="error">{error}</p>}
      </div>

      <button
        type="button"
        className="btn-secondary"
        onClick={() => {
          persistName();
          navigate('/solo');
        }}
      >
        Play Solo
      </button>

      <div className="home-links">
        <button type="button" className="home-profile-btn" onClick={() => navigate('/profile')}>
          <Avatar config={avatarConfig} size={32} />
          <span>My Profile</span>
        </button>
        <button type="button" className="dictionary-open-btn" onClick={() => setShowJournal(true)}>
          My Dictionaries
        </button>
      </div>

      {showJournal && <DictionaryJournal onClose={() => setShowJournal(false)} />}
    </div>
  );
}
