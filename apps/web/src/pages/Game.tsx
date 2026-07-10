import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { GridState } from '@plantain/shared';
import { api, ApiError } from '../lib/api.js';
import { fetchPlayers, fetchRoom, type PublicPlayer } from '../lib/rooms.js';
import { useRoomEvents } from '../hooks/useRoomEvents.js';
import { useSessionStore } from '../store/sessionStore.js';
import { computeUnplaced, newRackTile, type RackTile } from '../lib/rackUtils.js';
import GridCanvas from '../components/GridCanvas.js';
import TileRack from '../components/TileRack.js';
import BunchGraphic from '../components/BunchGraphic.js';

export default function Game() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const profileId = useSessionStore((s) => s.profileId);

  const [grid, setGrid] = useState<GridState>({});
  const [unplaced, setUnplaced] = useState<RackTile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bunchCount, setBunchCount] = useState(144);
  const [players, setPlayers] = useState<PublicPlayer[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadState = useCallback(async () => {
    if (!roomId) return;
    const [state, room, playerList] = await Promise.all([
      api.getMyState(roomId),
      fetchRoom(roomId),
      fetchPlayers(roomId),
    ]);
    setGrid(state.grid);
    setUnplaced(computeUnplaced(state.rack, state.grid));
    setPlayers(playerList);
    if (room) setBunchCount(room.bunch_count);
  }, [roomId]);

  useEffect(() => {
    loadState();
  }, [loadState]);

  useRoomEvents(roomId, (event) => {
    if (event.type === 'game_over') {
      navigate(`/room/${roomId}/results`, { replace: true });
      return;
    }
    if (event.type === 'peel' || event.type === 'dump' || event.type === 'game_started') {
      const payload = event.payload as { bunchCount?: number };
      if (typeof payload.bunchCount === 'number') setBunchCount(payload.bunchCount);
      if (roomId) fetchPlayers(roomId).then(setPlayers);
    }
    if (event.type === 'plantains_rejected') {
      const payload = event.payload as { actor: string; reason: string };
      if (payload.actor !== profileId) {
        setMessage(`Someone's Plantains! call was rejected (${payload.reason}) — keep playing.`);
      }
    }
  });

  function placeTile(x: number, y: number) {
    const key = `${x},${y}`;
    if (grid[key]) {
      // Pick the tile back up.
      const letter = grid[key];
      const next = { ...grid };
      delete next[key];
      setGrid(next);
      setUnplaced((u) => [...u, newRackTile(letter)]);
      return;
    }
    if (!selectedId) return;
    const tile = unplaced.find((t) => t.id === selectedId);
    if (!tile) return;
    setGrid((g) => ({ ...g, [key]: tile.letter }));
    setUnplaced((u) => u.filter((t) => t.id !== selectedId));
    setSelectedId(null);
  }

  async function handlePeel() {
    if (!roomId) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.peel(roomId, grid);
      setUnplaced(computeUnplaced(result.rack, grid));
      setBunchCount(result.bunchCount);
    } catch (err) {
      setMessage(err instanceof ApiError ? `Peel failed: ${err.message}` : 'Peel failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleDump() {
    if (!roomId || !selectedId) return;
    const tile = unplaced.find((t) => t.id === selectedId);
    if (!tile) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.dump(roomId, tile.letter);
      setUnplaced(computeUnplaced(result.rack, grid));
      setBunchCount(result.bunchCount);
      setSelectedId(null);
    } catch (err) {
      setMessage(err instanceof ApiError ? `Dump failed: ${err.message}` : 'Dump failed');
    } finally {
      setBusy(false);
    }
  }

  async function handlePlantains() {
    if (!roomId) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.plantains(roomId, grid);
      navigate(`/room/${roomId}/results`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        const invalidWords = (err.body as { invalidWords?: string[] }).invalidWords;
        setMessage(
          invalidWords?.length
            ? `Rotten Plantains! Not real words: ${invalidWords.join(', ')}`
            : `Rotten Plantains! ${err.message}`,
        );
      } else {
        setMessage('Plantains call failed');
      }
    } finally {
      setBusy(false);
    }
  }

  const opponents = players.filter((p) => p.profile_id !== profileId && !p.is_spectator);

  return (
    <div className="game-layout">
      <div className="game-sidebar">
        <BunchGraphic bunchCount={bunchCount} />
        <h3>Opponents</h3>
        <ul className="player-list">
          {opponents.map((p) => (
            <li key={p.profile_id}>
              {p.display_name}: {p.tile_count} tiles
              {!p.connected ? ' (disconnected)' : ''}
            </li>
          ))}
        </ul>
        <div className="actions">
          <button disabled={busy} onClick={handlePeel}>
            Peel!
          </button>
          <button disabled={busy || !selectedId} onClick={handleDump}>
            Dump!
          </button>
          <button disabled={busy} onClick={handlePlantains}>
            Plantains!
          </button>
        </div>
        {message && <p className="error">{message}</p>}
        <TileRack tiles={unplaced} selectedId={selectedId} onSelect={setSelectedId} />
      </div>
      <div className="game-board">
        <GridCanvas
          grid={grid}
          width={800}
          height={700}
          canPlace={!!selectedId}
          onCellClick={placeTile}
        />
      </div>
    </div>
  );
}
