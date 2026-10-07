import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { currentStreak, solvedTodayRoomId } from '../lib/dailyStreak.js';
import { useLocalDate } from '../hooks/useLocalDate.js';
import { validateDisplayName } from '@plantain/shared';
import { api, getErrorMessage } from '../lib/api.js';
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
  // Re-renders at local midnight so the streak badge and the Daily button's target roll over.
  useLocalDate();
  const streak = currentStreak();

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
      setError(getErrorMessage(err, 'Failed to create room'));
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
      setError(getErrorMessage(err, 'Failed to join room'));
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
        {/* A div, not the old wrapping <label>: the Profile button now sits inside the field, and
            interactive content nested in a <label> is invalid and muddies what a click activates. */}
        <div className="field">
          <label htmlFor="home-display-name">Display name</label>
          <div className="name-field">
            <input
              id="home-display-name"
              className="name-field-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Guest"
              maxLength={24}
            />
            <button
              type="button"
              className="home-profile-inline"
              onClick={() => navigate('/profile')}
              aria-label="My Profile"
            >
              <Avatar config={avatarConfig} size={22} />
              <span>Profile</span>
            </button>
          </div>
        </div>

        <button disabled={busy} onClick={handleCreate}>
          Create Room
        </button>

        <div className="or-divider">
          <span>or</span>
        </div>

        <div className="join-row">
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="Room code"
            maxLength={6}
          />
          <button className="btn-secondary" disabled={busy || !joinCode.trim()} onClick={handleJoin}>
            Join
          </button>
        </div>

        {error && <p className="error">{error}</p>}
      </div>

      <div className="home-modes">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            persistName();
            const solvedRoom = solvedTodayRoomId();
            navigate(solvedRoom ? `/room/${solvedRoom}/results` : '/daily');
          }}
        >
          Daily Puzzle
          {streak > 0 && <span className="home-mode-streak">🔥{streak}</span>}
        </button>
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
      </div>

      <div className="home-links">
        <button type="button" className="dictionary-open-btn" onClick={() => setShowJournal(true)}>
          My Dictionaries
        </button>
      </div>

      {showJournal && <DictionaryJournal onClose={() => setShowJournal(false)} />}
    </div>
  );
}
