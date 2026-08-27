import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  XTINA_STEPS,
  XTINA_WORD_LIST,
  xtinaAccentCells,
  xtinaGridMatches,
} from '@plantain/shared';
import {
  fetchRoomBoards,
  resolveBoardWords,
  EMPTY_BOARD_WORDS,
  type BoardWords,
  type RoomBoardRow,
} from '../lib/boards.js';
import { useSessionStore } from '../store/sessionStore.js';
import Avatar from '../components/Avatar.js';
import BoardPreview from '../components/BoardPreview.js';

/**
 * Post-game board viewer: look at what everyone actually built.
 *
 * Keyed on the ROOM, not the game — the boards live on room_players and die with the room, so
 * this screen only exists for as long as the room does. That's also exactly as long as it was
 * ever reachable: Results renders off rooms_public, so once the room is gone there's no
 * navigation path here either.
 *
 * Deliberately its own route rather than a modal over Results — it has its own top bar (no
 * Bunch, no score pills, no tray) and owns the full viewport.
 */
/** Stable empties/constants — a fresh Set per render would defeat memoization downstream. */
const EMPTY_CELLS: Set<string> = new Set();
const SCRIPTED_WORDS: ReadonlySet<string> = new Set(XTINA_WORD_LIST);

export default function BoardViewer() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const profileId = useSessionStore((s) => s.profileId);

  const [boards, setBoards] = useState<RoomBoardRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Word resolution costs a round-trip per board, so cache it per player — clicking back and
  // forth between two players shouldn't re-validate the same grid every time.
  const [wordsByPlayer, setWordsByPlayer] = useState<Record<string, BoardWords>>({});

  // Every client persists its own final board asynchronously as the game ends, so the first
  // read often lands before some players' boards exist. Refetch once shortly after to pick up
  // the stragglers — same pattern the Results screen uses for its stats.
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    // `cancelled` only guards post-unmount updates -- it doesn't order the immediate call against
    // the delayed one. Without `latestSeq`, a slow immediate load() resolving after the delayed
    // one (which picked up a straggler's board) would revert setBoards to the shorter list,
    // making a player's tab disappear right after it appeared.
    let latestSeq = 0;
    async function load() {
      const seq = ++latestSeq;
      const rows = await fetchRoomBoards(roomId!);
      if (cancelled || seq !== latestSeq) return;
      setBoards(rows);
      setLoading(false);
    }
    load();
    const t = setTimeout(load, 1500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [roomId]);

  // Default to your own board — it's the one you actually want to see first.
  useEffect(() => {
    if (selectedId || boards.length === 0) return;
    const mine = boards.find((b) => b.profile_id === profileId);
    setSelectedId((mine ?? boards[0]).profile_id);
  }, [boards, profileId, selectedId]);

  const selected = boards.find((b) => b.profile_id === selectedId) ?? null;

  // Is this the completed scripted board? Checked against the board itself rather than the room's
  // mode, which keeps this screen self-contained (no extra fetch) and makes it impossible to
  // mislabel somebody else's board — only the finished 56-cell script matches.
  const isScripted = selected ? xtinaGridMatches(selected.grid_state ?? {}, XTINA_STEPS) : false;
  const scriptedAccents = useMemo(
    () => (isScripted ? xtinaAccentCells() : EMPTY_CELLS),
    [isScripted],
  );

  useEffect(() => {
    if (!roomId || !selected) return;
    const key = selected.profile_id;
    if (wordsByPlayer[key]) return;
    let cancelled = false;
    // A scripted board's words are correct by construction, so they bypass the dictionary — the
    // viewer used to drop YOURE entirely, which is the word the board is built around.
    const alwaysValid = isScripted ? SCRIPTED_WORDS : undefined;
    resolveBoardWords(roomId, selected.grid_state, alwaysValid).then((res) => {
      if (!cancelled) setWordsByPlayer((prev) => ({ ...prev, [key]: res }));
    });
    return () => {
      cancelled = true;
    };
  }, [roomId, selected, wordsByPlayer, isScripted]);

  const words = (selected && wordsByPlayer[selected.profile_id]) ?? EMPTY_BOARD_WORDS;
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
            grid={selected.grid_state ?? {}}
            validCells={words.validCells}
            accentCells={scriptedAccents}
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
          {words.words.length ? (
            <div className="viewer-word-list">
              {words.words.map((w, i) => (
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
