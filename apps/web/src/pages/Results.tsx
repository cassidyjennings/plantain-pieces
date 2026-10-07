import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { ACHIEVEMENT_DEFS, FREEZE_DURATION_MS, type AchievementType, type SoloModeConfig } from '@plantain/shared';
import { fetchDisplayName, fetchPlayers, fetchRoom, type PublicPlayer, type PublicRoom } from '../lib/rooms.js';
import { fetchMyAchievements } from '../lib/profile.js';
import { fetchRoomBoards, resolveBoardWords, type RoomBoardRow } from '../lib/boards.js';
import { resultsFetchPlan } from '../lib/resultsPlan.js';
import { useRoomEvents } from '../hooks/useRoomEvents.js';
import { useSessionStore } from '../store/sessionStore.js';
import { api, ApiError, getErrorMessage, type DailyResultSummary } from '../lib/api.js';
import { recordSolved, recordDailyResult, currentStreak, getLastResult } from '../lib/dailyStreak.js';
import BoardPreview from '../components/BoardPreview.js';
import DailyYourGame from '../components/DailyYourGame.js';

export default function Results() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const profileId = useSessionStore((s) => s.profileId);
  const displayName = useSessionStore((s) => s.displayName);
  const [room, setRoom] = useState<PublicRoom | null>(null);
  const [winnerName, setWinnerName] = useState<string>('');
  const [me, setMe] = useState<PublicPlayer | null>(null);
  const [longestWord, setLongestWord] = useState<string | null>(null);
  const [earned, setEarned] = useState<AchievementType[]>([]);
  // Distinct from `me`/`earned` being merely present: this flips true only once the LAST
  // scheduled achievements re-check has landed, so the achievements sub-section can show a
  // placeholder instead of silently having zero, then suddenly gaining a box once the
  // word-based achievements (submitted async by the client, see submitSummaryOnce in Game.tsx)
  // actually land.
  const [achievementsSettled, setAchievementsSettled] = useState(false);
  const [rematching, setRematching] = useState(false);
  const [rematchError, setRematchError] = useState<string | null>(null);
  const [myBoard, setMyBoard] = useState<RoomBoardRow | null>(null);
  const [myMitCells, setMyMitCells] = useState<Set<string>>(new Set());
  const [boardCount, setBoardCount] = useState(0);
  // True once the board read has a real answer (our board's words resolved) or its final retry
  // ran. Until then the board window and the Longest word value hold placeholders.
  const [boardsSettled, setBoardsSettled] = useState(false);
  // null until the solve is recorded below, so the Day streak tile shows a skeleton instead of
  // flashing 0 for a render.
  const [streak, setStreak] = useState<number | null>(null);
  // longestWord === null means both "not loaded yet" and "no words"; only the first is a skeleton.
  const [longestWordReady, setLongestWordReady] = useState(false);
  // True once the LAST scheduled summary attempt lands or fails, so an early `available: false`
  // (archive_game not written yet) keeps the skeleton instead of flashing "-".
  const [dailySummarySettled, setDailySummarySettled] = useState(false);
  const [roomMissing, setRoomMissing] = useState(false);
  const [dailySummary, setDailySummary] = useState<DailyResultSummary | null>(null);

  useEffect(() => {
    if (!roomId) return;
    fetchRoom(roomId).then(async (r) => {
      setRoom(r);
      setRoomMissing(r === null);
      if (r?.winner_id) setWinnerName(await fetchDisplayName(r.winner_id));
    });
  }, [roomId]);

  const roomMode = room?.mode;

  // `me` only feeds the Tiles tile, which is final the moment the game ends, so one read is
  // enough. It needs nothing from the room, so it starts on mount alongside fetchRoom.
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    fetchPlayers(roomId).then((players) => {
      if (!cancelled) setMe(players.find((p) => p.profile_id === profileId) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [roomId, profileId]);

  // This game's achievements are matched on the roomId their meta carries (nothing per-game is
  // stored, migration 20260728000006). The mode decides whether to look at all: daily can't
  // unlock any of them, so it skips the read and its re-polls entirely (resultsFetchPlan).
  useEffect(() => {
    if (!roomId || !roomMode) return;
    const plan = resultsFetchPlan(roomMode);
    if (!plan.achievements) {
      setAchievementsSettled(true);
      return;
    }
    let cancelled = false;
    setAchievementsSettled(false);
    // `cancelled` only guards post-unmount updates. `latestSeq` stops a slow, earlier-issued
    // read from resolving after a later one and reverting to an incomplete snapshot.
    let latestSeq = 0;
    const rechecks = plan.achievementRechecksMs;
    async function load(isFinal: boolean) {
      const seq = ++latestSeq;
      const achievements = await fetchMyAchievements();
      if (cancelled || seq !== latestSeq) return;
      setEarned(
        achievements
          .filter((a) => (a.meta as { roomId?: string })?.roomId === roomId)
          .map((a) => a.type),
      );
      if (isFinal) setAchievementsSettled(true);
    }
    load(rechecks.length === 0);
    const timers = rechecks.map((ms, i) => setTimeout(() => load(i === rechecks.length - 1), ms));
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [roomId, roomMode]);

  // Your own final board, for the preview window. Retried once at 1000ms because every client
  // persists its board asynchronously right as the game ends, including this one. Needs nothing
  // from the room, so it starts on mount.
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    // Same ordering guard as the achievements effect above.
    let latestSeq = 0;
    async function load(isFinal: boolean) {
      const seq = ++latestSeq;
      try {
        const rows = await fetchRoomBoards(roomId!);
        if (cancelled || seq !== latestSeq) return;
        setBoardCount(rows.length);
        const mine = rows.find((r) => r.profile_id === profileId) ?? null;
        setMyBoard(mine);
        // Longest word is derived from the board rather than read back from a stored record.
        if (mine) {
          const { words, mitCells } = await resolveBoardWords(roomId!, mine.grid_state);
          if (cancelled || seq !== latestSeq) return;
          setMyMitCells(mitCells);
          setLongestWord(
            words.reduce<string | null>((best, w) => (!best || w.length > best.length ? w : best), null),
          );
          setLongestWordReady(true);
        }
        if (mine || isFinal) setBoardsSettled(true);
      } finally {
        // The last retry settles the daily Longest word tile either way, so a board that never
        // arrived (or whose words failed to resolve) shows "-" rather than an endless skeleton.
        if (isFinal && !cancelled) setLongestWordReady(true);
      }
    }
    load(false);
    const t = setTimeout(() => load(true), 1000);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [roomId, profileId]);

  // Record the daily solve under the puzzle's own date. Re-runs when longestWord resolves:
  // recording once, as soon as the board row arrived, saved the null it holds before the board's
  // words load. Keyed by puzzle date, so a puzzle finished after midnight still counts for its
  // day, and reopening an older room can only re-record that older day.
  useEffect(() => {
    if (!room || room.mode !== 'daily' || room.status !== 'finished') return;
    const scheduled = (room.mode_config as { scheduledDate?: string }).scheduledDate;
    if (!scheduled) return;
    const dur =
      room.started_at && room.finished_at
        ? new Date(room.finished_at).getTime() - new Date(room.started_at).getTime()
        : 0;
    recordSolved(scheduled);
    recordDailyResult(scheduled, room.id, dur, longestWord);
    // State, not a render-time read: recording happens after render, so reading localStorage
    // during render showed the pre-solve streak until some unrelated state change re-rendered.
    setStreak(currentStreak());
  }, [room, longestWord]);

  // The beat-percent comparison depends on the same async archive_game write as the streak
  // recording above, so it uses the same "fetch, then retry once after the write has likely
  // landed" pattern as the board-fetch effect.
  useEffect(() => {
    if (!room || !resultsFetchPlan(room.mode).dailySummary || room.status !== 'finished') return;
    const puzzleId = (room.mode_config as { puzzleId?: string }).puzzleId;
    if (!puzzleId) {
      setDailySummarySettled(true);
      return;
    }
    let cancelled = false;
    let latestSeq = 0;
    async function load(isFinal: boolean) {
      const seq = ++latestSeq;
      try {
        const summary = await api.getDailyResultSummary(puzzleId!);
        if (cancelled || seq !== latestSeq) return;
        setDailySummary(summary);
      } catch {
        // A failed attempt keeps whatever an earlier one returned; the final one settles below.
      } finally {
        if (isFinal && !cancelled) setDailySummarySettled(true);
      }
    }
    load(false);
    const t = setTimeout(() => load(true), 1000);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [room]);

  // A rematch resets THIS room back to a lobby, so everyone still on the results screen has to
  // follow it there — otherwise only the player who clicked would move and the others would sit
  // on a results screen for a game that no longer exists.
  useRoomEvents(roomId, (event) => {
    if (event.type === 'rematch') navigate(`/room/${roomId}`, { replace: true });
  });

  if (!room) {
    // Home reopens today's daily results by room id; once the room is cleaned up there's nothing
    // to load, so fall back to the daily page's own solved view instead of loading forever.
    if (roomMissing && getLastResult()?.roomId === roomId) return <Navigate to="/daily" replace />;
    return <div className="centered">Loading results...</div>;
  }

  const won = room.winner_id === profileId;
  const isSolo = room.mode === 'solo';
  const isDaily = room.mode === 'daily';
  // Daily's "Your game" panel shows nothing that comes from `me` (no Tiles tile), so it renders
  // as soon as the room does, instead of waiting on the players read.
  const gameReady = isDaily || me != null;
  const isTimed = isSolo && (room.mode_config as { timed?: boolean }).timed === true;
  // Derived from the room's own timestamps rather than a stored duration_ms. A FREEZE easter egg
  // (Timed solo) took 10 s off the clock — the archived best time already subtracts it, so the
  // tile must too or the two disagree.
  const rawDurationMs =
    room.started_at && room.finished_at
      ? new Date(room.finished_at).getTime() - new Date(room.started_at).getTime()
      : null;
  const durationMs =
    rawDurationMs !== null && isTimed && me?.freeze_used
      ? Math.max(0, rawDurationMs - FREEZE_DURATION_MS)
      : rawDurationMs;
  const scheduledDate = (room.mode_config as { scheduledDate?: string }).scheduledDate;
  const headline = isDaily
    ? scheduledDate
      ? new Date(`${scheduledDate}T00:00:00`).toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        })
      : 'Daily Puzzle'
    : isSolo
      ? 'You cleared the Bunch!'
      : won
        ? 'You take the win!'
        : `${winnerName} takes the win!`;
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
      setRematchError(getErrorMessage(err, 'Failed to start a new game'));
      setRematching(false);
    }
  }

  const shareDate =new Date(scheduledDate ? `${scheduledDate}T00:00:00` : Date.now())
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const shareText = [
    'Plantain Pieces Daily Puzzle',
    `📅 ${shareDate}`,
    durationMs != null
      ? `⏱ ${Math.floor(durationMs / 60000)}:${Math.floor((durationMs % 60000) / 1000).toString().padStart(2, '0')}`
      : '',
    streak != null && streak > 0 ? `🔥 ${streak}-day streak` : '',
    // The word itself would spoil the puzzle for anyone this gets shared with — length only.
    longestWord ? `📝 Longest word: ${longestWord.length} letters` : '',
    'plantainpieces.com',
  ].filter(Boolean).join('\n');

  return (
    <div className="centered">
      {isDaily ? (
        <div className="daily-solved-head">
          <h1 className="results-callout daily-solved-callout">Solved!</h1>
          <p className="winner-line">{headline}</p>
        </div>
      ) : (
        <>
          <h1 className="results-callout">PLANTAINS!</h1>
          <p className="winner-line">{headline}</p>
        </>
      )}

      {/* Daily never waits on `me`: none of its four tiles come from fetchPlayers, and each tile
          holds its own skeleton until its value lands. */}
      {isDaily && (
        <DailyYourGame
          longestWord={longestWord}
          longestWordReady={longestWordReady}
          durationMs={durationMs}
          streak={streak}
          summary={dailySummary}
          summarySettled={dailySummarySettled}
          shareText={shareText}
        />
      )}

      {/* Skeleton mirrors the real panel's tile layout (same conditionals, no values yet) so
          when `me` lands the content fills in place instead of a new box appearing below. */}
      {!isDaily && !gameReady && (
        <div className="panel results-earned" aria-hidden="true">
          <h3>Your game</h3>
          <div className="results-stat-row">
            {!isSolo && (
              <div className="stat-tile">
                <span className="stat-value"><span className="skeleton-bar" /></span>
                <span className="stat-label">Result</span>
              </div>
            )}
            <div className="stat-tile">
              <span className="stat-value"><span className="skeleton-bar" /></span>
              <span className="stat-label">Tiles</span>
            </div>
            <div className="stat-tile">
              <span className="stat-value"><span className="skeleton-bar" /></span>
              <span className="stat-label">Longest word</span>
            </div>
            {isTimed && durationMs != null && (
              <div className="stat-tile">
                <span className="stat-value"><span className="skeleton-bar" /></span>
                <span className="stat-label">Time</span>
              </div>
            )}
          </div>
        </div>
      )}

      {!isDaily && gameReady && (
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
              <span className="stat-value">{me?.tile_count ?? '-'}</span>
              <span className="stat-label">Tiles</span>
            </div>
            <div className="stat-tile">
              <span className="stat-value">
                {longestWord ?? (boardsSettled ? '-' : <span className="skeleton-bar" />)}
              </span>
              <span className="stat-label">Longest word</span>
            </div>
            {isTimed && durationMs != null && (
              <div className="stat-tile">
                <span className="stat-value">
                  {Math.floor(durationMs / 60000)}:
                  {Math.floor((durationMs % 60000) / 1000).toString().padStart(2, '0')}
                </span>
                <span className="stat-label">Time</span>
              </div>
            )}
          </div>
          {earned.length === 0 && !achievementsSettled && (
            <div className="results-achievements" aria-hidden="true">
              <span className="results-achievements-label">
                Checking achievements… <span className="skeleton-bar" />
              </span>
            </div>
          )}
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

      {/* Same shell, title and fixed-height frame as the real window below, so the board
          landing swaps content in place instead of inserting a box. */}
      {!myBoard && !boardsSettled && (
        <div className="results-board-window results-board-window-placeholder" aria-hidden="true">
          <span className="results-board-window-head">
            <span className="results-board-window-title">
              {isSolo || isDaily ? 'Your board' : "Everyone's boards"}
            </span>
            <span className="results-board-window-hint">
              <span className="skeleton-bar" />
            </span>
          </span>
          <span className="results-board-window-frame" />
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
              {isSolo || isDaily ? 'Your board' : "Everyone's boards"}
            </span>
            <span className="results-board-window-hint">
              {isSolo || isDaily || boardCount <= 1 ? 'Take a look' : `Compare all ${boardCount} →`}
            </span>
          </span>
          <span className="results-board-window-frame">
            <BoardPreview
              grid={myBoard.grid_state ?? {}}
              mitCells={myMitCells}
              label="Your final board"
              emptyMessage="Saving your board…"
            />
          </span>
        </button>
      )}

      {rematchError && <p className="error">{rematchError}</p>}

      {isDaily ? (
        <>
          <p className="daily-note">Come back tomorrow for the next puzzle.</p>
          <button className="btn-secondary" onClick={() => navigate('/')}>
            Back to Home
          </button>
        </>
      ) : (
        <>
          <button disabled={rematching} onClick={handlePlayAgain}>
            {rematching ? 'Starting…' : isSolo ? 'Play Again' : 'Rematch'}
          </button>
          <button className="btn-secondary" disabled={rematching} onClick={() => navigate('/')}>
            Back to Home
          </button>
        </>
      )}
    </div>
  );
}
