import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { fetchGameBoards, validCellsFor, type GameBoardRow } from '../lib/boards.js';
import { fetchMyMatchHistory } from '../lib/profile.js';
import { useSessionStore } from '../store/sessionStore.js';
import Avatar from '../components/Avatar.js';
import BoardPreview from '../components/BoardPreview.js';

/**
 * Post-game board viewer: look at what everyone actually built.
 *
 * Deliberately its own route rather than a modal over Results — it has its own top bar (no
 * Bunch, no score pills, no tray) and owns the full viewport, which is awkward to fake inside
 * Results' centered column layout. A route also gets working browser-back for free.
 */
export default function BoardViewer() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const profileId = useSessionStore((s) => s.profileId);

  // Boards are keyed by game, but the route is keyed by room. Results already knows the gameId
  // and passes it through route state; the match-history fallback covers a refresh or a
  // deep-link, where that state is gone.
  const passedGameId = (location.state as { gameId?: string } | null)?.gameId ?? null;
  const [gameId, setGameId] = useState<string | null>(passedGameId);
  const [boards, setBoards] = useState<GameBoardRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (gameId) return;
    let cancelled = false;
    fetchMyMatchHistory().then((history) => {
      if (cancelled) return;
      const latest = history[0] ?? null;
      setGameId(latest?.game_id ?? null);
      if (!latest) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [gameId]);

  // Every client submits its own end-of-game summary asynchronously as the game ends, so the
  // first read here often lands before some players' boards exist. Refetch once shortly after
  // to pick up the stragglers — same pattern the Results screen uses for its stats.
  useEffect(() => {
    if (!gameId) return;
    let cancelled = false;
    async function load() {
      const rows = await fetchGameBoards(gameId!);
      if (cancelled) return;
      setBoards(rows);
      setLoading(false);
    }
    load();
    const t = setTimeout(load, 1500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [gameId]);

  // Default to your own board — it's the one you actually want to see first.
  useEffect(() => {
    if (selectedId || boards.length === 0) return;
    const mine = boards.find((b) => b.profile_id === profileId);
    setSelectedId((mine ?? boards[0]).profile_id);
  }, [boards, profileId, selectedId]);

  const selected = boards.find((b) => b.profile_id === selectedId) ?? null;

  const validCells = useMemo(() => validCellsFor(selected), [selected]);

  const isSelf = selected?.profile_id === profileId;

  return (
    <div className="viewer-layout">
      <div className="viewer-topbar">
        {/* Tabs, not just buttons: this is exactly the tablist pattern — picking which one of
            several panels of content is shown. */}
        <div className="viewer-tabs" role="tablist" aria-label="Players">
          {boards.map((b) => (
            <button
              key={b.profile_id}
              type="button"
              role="tab"
              aria-selected={b.profile_id === selectedId}
              className={`viewer-tab${b.profile_id === selectedId ? ' active' : ''}`}
              onClick={() => setSelectedId(b.profile_id)}
            >
              <Avatar config={b.avatar_config} size={26} />
              <span className="viewer-tab-name">
                {b.profile_id === profileId ? 'You' : b.display_name}
              </span>
              {/* Not colour alone — the winner also gets a glyph, so the marker survives a
                  colourblind mode or a low-contrast screen. */}
              {b.is_winner && (
                <span className="viewer-tab-crown" title="Winner" aria-label="Winner">
                  ★
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="viewer-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => navigate(`/room/${roomId}/results`)}
          >
            ← Results
          </button>
          <button type="button" className="btn-leave" onClick={() => navigate('/')}>
            Leave
          </button>
        </div>
      </div>

      <div className="viewer-board-area">
        {loading ? (
          <p className="hint">Loading boards…</p>
        ) : !selected ? (
          <p className="hint">No boards to show for this game.</p>
        ) : (
          <BoardPreview
            grid={selected.final_grid ?? {}}
            validCells={validCells}
            label={`${isSelf ? 'Your' : `${selected.display_name}'s`} final board`}
            emptyMessage={
              isSelf
                ? "Your board wasn't saved for this game."
                : `${selected.display_name} didn't finish with a saved board.`
            }
          />
        )}
      </div>

      {selected && (
        <div className="viewer-words">
          <span className="viewer-words-label">
            {isSelf ? 'Your words' : `${selected.display_name}'s words`}
          </span>
          {selected.words_played?.length ? (
            <div className="viewer-word-list">
              {selected.words_played.map((w, i) => (
                <span key={`${w}-${i}`} className="viewer-word">
                  {w}
                </span>
              ))}
            </div>
          ) : (
            <p className="hint">No words recorded.</p>
          )}
        </div>
      )}
    </div>
  );
}
