import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getErrorMessage, type DailyTodayResult } from '../lib/api.js';
import { useSessionStore } from '../store/sessionStore.js';
import { useLocalDate } from '../hooks/useLocalDate.js';
import {
  isSolvedToday,
  currentStreak,
  bestStreak,
  totalSolved,
  getLastResult,
} from '../lib/dailyStreak.js';

function fmtMs(ms: number): string {
  return `${Math.floor(ms / 60000)}:${Math.floor((ms % 60000) / 1000).toString().padStart(2, '0')}`;
}

export default function DailyPage() {
  const navigate = useNavigate();
  const displayName = useSessionStore((s) => s.displayName);
  const today = useLocalDate();
  const [daily, setDaily] = useState<DailyTodayResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alreadySolved = isSolvedToday();
  const lastResult = getLastResult();
  const todaysResult = alreadySolved && lastResult?.date === today ? lastResult : null;
  const name = displayName.trim() || 'Guest';

  // Refetched when the local date rolls over, so a page left open past midnight moves on to the
  // new day's puzzle.
  useEffect(() => {
    let cancelled = false;
    setDaily(null);
    setLoadError(null);
    api
      .getDailyToday(today)
      .then((r) => {
        if (!cancelled) setDaily(r);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(getErrorMessage(err, "Couldn't load today's puzzle"));
      });
    return () => {
      cancelled = true;
    };
  }, [today]);

  async function handlePlay() {
    setPlaying(true);
    setError(null);
    try {
      const room = await api.createDailyRoom(name, today);
      navigate(`/room/${room.roomId}/game`);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to start daily puzzle'));
      setPlaying(false);
    }
  }

  const dateLabel = daily?.puzzleDate
    ? new Date(`${daily.puzzleDate}T00:00:00`).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      })
    : null;

  const streakStats = [
    { label: 'Current streak', value: currentStreak() },
    { label: 'Best streak', value: bestStreak() },
    { label: 'Days solved', value: totalSolved() },
  ];

  const rules = [
    { label: 'Tiles', value: daily?.tileCount ?? '–' },
    { label: 'Min. word length', value: daily?.minLength ? `${daily.minLength}+` : '–' },
    { label: 'Dump', value: 'Off' },
  ];

  let status;
  if (loadError) {
    status = <p className="error">{loadError}</p>;
  } else if (!daily) {
    status = <p className="daily-note">Checking today's puzzle…</p>;
  } else if (alreadySolved) {
    status = (
      <>
        <p className="daily-solved-label">Solved today!</p>
        {todaysResult && (
          <div className="results-stat-row">
            {todaysResult.durationMs > 0 && (
              <div className="stat-tile">
                <span className="stat-value">{fmtMs(todaysResult.durationMs)}</span>
                <span className="stat-label">Time</span>
              </div>
            )}
            {todaysResult.longestWord && (
              <div className="stat-tile">
                <span className="stat-value">{todaysResult.longestWord}</span>
                <span className="stat-label">Longest word</span>
              </div>
            )}
          </div>
        )}
        <p className="daily-note">Come back tomorrow for the next puzzle.</p>
      </>
    );
  } else if (!daily.hasDaily) {
    status = <p className="daily-note">No puzzle today — check back soon!</p>;
  } else {
    status = (
      <>
        <p className="daily-note">Use every tile in one connected grid. The clock starts when you do.</p>
        {error && <p className="error">{error}</p>}
        <button className="btn-split" disabled={playing} onClick={handlePlay}>
          {playing ? 'Starting…' : "Play Today's Puzzle"}
        </button>
      </>
    );
  }

  return (
    <div className="centered solo-screen">
      <button type="button" className="solo-back" disabled={playing} onClick={() => navigate('/')}>
        ← <span className="solo-back-full">Back to </span>Menu
      </button>

      <div className="daily-header">
        <h1 className="solo-title">Daily Puzzle</h1>
        {dateLabel && <p className="daily-date">{dateLabel}</p>}
      </div>

      <div className="solo-panel daily-panel">
        <div className="solo-section">
          <span className="solo-section-label">Your streak</span>
          <div className="results-stat-row">
            {streakStats.map((s) => (
              <div key={s.label} className="stat-tile">
                <span className="stat-value">{s.value}</span>
                <span className="stat-label">{s.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="solo-rules">
          {rules.map((r) => (
            <div key={r.label} className="solo-rule">
              <span className="solo-rule-label">{r.label}</span>
              <div className="solo-rule-box">
                <span className="daily-rule-value">{r.value}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="daily-status">{status}</div>
      </div>
    </div>
  );
}
