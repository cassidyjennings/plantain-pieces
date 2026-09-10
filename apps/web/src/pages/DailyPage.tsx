import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getErrorMessage } from '../lib/api.js';
import { useSessionStore } from '../store/sessionStore.js';
import { isSolvedToday, currentStreak, getLastResult } from '../lib/dailyStreak.js';

function fmtMs(ms: number): string {
  return `${Math.floor(ms / 60000)}:${Math.floor((ms % 60000) / 1000).toString().padStart(2, '0')}`;
}

export default function DailyPage() {
  const navigate = useNavigate();
  const displayName = useSessionStore((s) => s.displayName);
  const [hasDaily, setHasDaily] = useState<boolean | null>(null);
  const [puzzleDate, setPuzzleDate] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alreadySolved = isSolvedToday();
  const streak = currentStreak();
  const lastResult = getLastResult();
  const name = displayName.trim() || 'Guest';

  useEffect(() => {
    api.getDailyToday()
      .then((r) => { setHasDaily(r.hasDaily); setPuzzleDate(r.puzzleDate); })
      .catch(() => { setHasDaily(false); });
  }, []);

  async function handlePlay() {
    setPlaying(true);
    setError(null);
    try {
      const room = await api.createDailyRoom(name);
      navigate(`/room/${room.roomId}/game`);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to start daily puzzle'));
      setPlaying(false);
    }
  }

  const dateLabel = puzzleDate
    ? new Date(puzzleDate + 'T00:00:00').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
      })
    : null;

  return (
    <div className="centered">
      <button type="button" className="btn-back-link" onClick={() => navigate('/')}>
        ← Back
      </button>

      <h1 className="daily-page-title">Daily Puzzle</h1>
      {dateLabel && <p className="daily-page-date">{dateLabel}</p>}

      {streak > 0 && (
        <div className="daily-streak-badge">
          🔥 {streak}-day streak
        </div>
      )}

      {hasDaily === null ? (
        <p className="daily-loading">Checking today's puzzle…</p>
      ) : alreadySolved ? (
        <div className="panel daily-solved-panel">
          <p className="daily-solved-label">Solved today!</p>
          {lastResult && lastResult.date === new Date().toISOString().slice(0, 10) && (
            <div className="results-stat-row">
              {lastResult.durationMs > 0 && (
                <div className="stat-tile">
                  <span className="stat-value">{fmtMs(lastResult.durationMs)}</span>
                  <span className="stat-label">Time</span>
                </div>
              )}
              {lastResult.longestWord && (
                <div className="stat-tile">
                  <span className="stat-value">{lastResult.longestWord}</span>
                  <span className="stat-label">Longest word</span>
                </div>
              )}
            </div>
          )}
          <p className="daily-comeback">Come back tomorrow for the next puzzle.</p>
        </div>
      ) : !hasDaily ? (
        <p className="daily-unavailable">No puzzle today — check back soon!</p>
      ) : (
        <>
          <p className="daily-tagline">Clear all the tiles to win!</p>
          {error && <p className="error">{error}</p>}
          <button disabled={playing} onClick={handlePlay}>
            {playing ? 'Starting…' : "Play Today's Puzzle"}
          </button>
        </>
      )}

      <button className="btn-secondary" onClick={() => navigate('/')}>
        Back to Home
      </button>
    </div>
  );
}
