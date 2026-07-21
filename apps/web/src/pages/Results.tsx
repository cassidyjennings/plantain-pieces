import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ACHIEVEMENT_DEFS, type AchievementType, type SoloModeConfig } from '@plantain/shared';
import { fetchDisplayName, fetchRoom, type PublicRoom } from '../lib/rooms.js';
import { fetchMyMatchHistory, fetchMyAchievements, type MatchHistoryRow } from '../lib/profile.js';
import { useSessionStore } from '../store/sessionStore.js';
import { api, ApiError } from '../lib/api.js';

export default function Results() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const profileId = useSessionStore((s) => s.profileId);
  const displayName = useSessionStore((s) => s.displayName);
  const [room, setRoom] = useState<PublicRoom | null>(null);
  const [winnerName, setWinnerName] = useState<string>('');
  const [match, setMatch] = useState<MatchHistoryRow | null>(null);
  const [earned, setEarned] = useState<AchievementType[]>([]);
  const [rematching, setRematching] = useState(false);
  const [rematchError, setRematchError] = useState<string | null>(null);

  useEffect(() => {
    if (!roomId) return;
    fetchRoom(roomId).then(async (r) => {
      setRoom(r);
      if (r?.winner_id) setWinnerName(await fetchDisplayName(r.winner_id));
    });
  }, [roomId]);

  // Load the freshly-archived match + any achievements earned in it. The client summary is
  // submitted asynchronously as the game ends, so refetch shortly after to catch word stats
  // and word-based achievements that land a beat later.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [history, achievements] = await Promise.all([fetchMyMatchHistory(), fetchMyAchievements()]);
      if (cancelled) return;
      const latest = history[0] ?? null;
      setMatch(latest);
      if (latest) {
        const here = achievements
          .filter((a) => (a.meta as { gameId?: string })?.gameId === latest.game_id)
          .map((a) => a.type);
        setEarned(here);
      }
    }
    load();
    const t = setTimeout(load, 1500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, []);

  if (!room) return <div className="centered">Loading results...</div>;

  const won = room.winner_id === profileId;
  const isSolo = room.mode === 'solo';
  const isTimed = isSolo && (room.mode_config as { timed?: boolean }).timed === true;
  const headline = isSolo ? 'You cleared the Bunch!' : won ? 'You take the win!' : `${winnerName} takes the win!`;
  const name = displayName.trim() || 'Guest';

  async function handlePlayAgain() {
    setRematching(true);
    setRematchError(null);
    try {
      if (isSolo) {
        const solo = await api.createSoloRoom(name, room!.dictionary_config, room!.mode_config as SoloModeConfig);
        navigate(`/room/${solo.roomId}/game`);
      } else {
        // A lightweight rematch: a fresh room with the same wordlist, ready for the same
        // players to rejoin via the new room code.
        const fresh = await api.createRoom(name, room!.dictionary_config);
        navigate(`/room/${fresh.roomId}`);
      }
    } catch (err) {
      setRematchError(err instanceof ApiError ? err.message : 'Failed to start a new game');
      setRematching(false);
    }
  }

  return (
    <div className="centered">
      <h1 className="results-callout">PLANTAINS!</h1>
      <p className="winner-line">{headline}</p>

      {match && (
        <div className="panel results-earned">
          <h3>Your game</h3>
          <div className="results-stat-row">
            {!isSolo && (
              <div className="stat-tile">
                <span className="stat-value">{won ? 'Win' : 'Loss'}</span>
                <span className="stat-label">Result</span>
              </div>
            )}
            <div className="stat-tile">
              <span className="stat-value">{match.final_tile_count}</span>
              <span className="stat-label">Tiles</span>
            </div>
            <div className="stat-tile">
              <span className="stat-value">{match.longest_word ?? '-'}</span>
              <span className="stat-label">Longest word</span>
            </div>
            {isTimed && match.duration_ms != null && (
              <div className="stat-tile">
                <span className="stat-value">
                  {Math.floor(match.duration_ms / 60000)}:
                  {Math.floor((match.duration_ms % 60000) / 1000).toString().padStart(2, '0')}
                </span>
                <span className="stat-label">Time</span>
              </div>
            )}
          </div>
          {earned.length > 0 && (
            <div className="results-achievements">
              <span className="results-achievements-label">Achievements unlocked</span>
              <div className="results-achievement-icons">
                {earned.map((t) => (
                  <span key={t} className="results-achievement" title={ACHIEVEMENT_DEFS[t].description}>
                    {ACHIEVEMENT_DEFS[t].title}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {rematchError && <p className="error">{rematchError}</p>}

      <button disabled={rematching} onClick={handlePlayAgain}>
        {rematching ? 'Starting…' : isSolo ? 'Play Again' : 'Rematch'}
      </button>
      <button className="btn-secondary" disabled={rematching} onClick={() => navigate('/')}>
        Back to Home
      </button>
    </div>
  );
}
