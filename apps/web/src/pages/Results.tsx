import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ACHIEVEMENT_DEFS, type AchievementType, type SoloModeConfig } from '@plantain/shared';
import { fetchDisplayName, fetchRoom, type PublicRoom } from '../lib/rooms.js';
import { fetchMyMatchHistory, fetchMyAchievements, type MatchHistoryRow } from '../lib/profile.js';
import { fetchRoomBoards, type RoomBoardRow } from '../lib/boards.js';
import { useRoomEvents } from '../hooks/useRoomEvents.js';
import { useSessionStore } from '../store/sessionStore.js';
import { api, ApiError } from '../lib/api.js';
import BoardPreview from '../components/BoardPreview.js';

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
  const [myBoard, setMyBoard] = useState<RoomBoardRow | null>(null);
  const [boardCount, setBoardCount] = useState(0);

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

  // Your own final board, for the preview window. Refetched on the same delay as the stats
  // above because every client persists its board asynchronously right as the game ends —
  // including this client's own.
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    async function load() {
      const rows = await fetchRoomBoards(roomId!);
      if (cancelled) return;
      setBoardCount(rows.length);
      setMyBoard(rows.find((r) => r.profile_id === profileId) ?? null);
    }
    load();
    const t = setTimeout(load, 1500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [roomId, profileId]);

  // A rematch resets THIS room back to a lobby, so everyone still on the results screen has to
  // follow it there — otherwise only the player who clicked would move and the others would sit
  // on a results screen for a game that no longer exists.
  useRoomEvents(roomId, (event) => {
    if (event.type === 'rematch') navigate(`/room/${roomId}`, { replace: true });
  });

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
        // Reset THIS room back to a lobby — same room id, same code, same players, same
        // wordlist. Creating a fresh room here (the old behavior) gave every player who
        // clicked their own private room with a new code, so a rematch could never happen.
        // The RPC is idempotent, so if someone else already rematched this just succeeds and
        // we follow them in; its `rematch` event moves everyone else.
        await api.rematchRoom(roomId!);
        navigate(`/room/${roomId}`);
      }
    } catch (err) {
      // Everyone left after the game, so leave_room tore the room down. Nothing to reset —
      // fall back to a brand-new room so the button still does something useful.
      if (err instanceof ApiError && err.message === 'ROOM_NOT_FOUND') {
        try {
          const fresh = await api.createRoom(name, room!.dictionary_config);
          navigate(`/room/${fresh.roomId}`);
          return;
        } catch {
          /* fall through to the error message below */
        }
      }
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

      {/* The board window: a look at what you actually built, and the way into everyone
          else's. Only offered once there's a game archived to look at. */}
      {myBoard && (
        <button
          type="button"
          className="results-board-window"
          onClick={() => navigate(`/room/${roomId}/boards`)}
        >
          <span className="results-board-window-head">
            <span className="results-board-window-title">
              {isSolo ? 'Your board' : "Everyone's boards"}
            </span>
            <span className="results-board-window-hint">
              {isSolo || boardCount <= 1 ? 'Take a look' : `Compare all ${boardCount} →`}
            </span>
          </span>
          <span className="results-board-window-frame">
            <BoardPreview
              grid={myBoard.grid_state ?? {}}
              label="Your final board"
              emptyMessage="Saving your board…"
            />
          </span>
        </button>
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
