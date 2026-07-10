import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchDisplayName, fetchRoom, type PublicRoom } from '../lib/rooms.js';
import { useSessionStore } from '../store/sessionStore.js';

export default function Results() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const profileId = useSessionStore((s) => s.profileId);
  const [room, setRoom] = useState<PublicRoom | null>(null);
  const [winnerName, setWinnerName] = useState<string>('');

  useEffect(() => {
    if (!roomId) return;
    fetchRoom(roomId).then(async (r) => {
      setRoom(r);
      if (r?.winner_id) setWinnerName(await fetchDisplayName(r.winner_id));
    });
  }, [roomId]);

  if (!room) return <div className="centered">Loading results...</div>;

  const won = room.winner_id === profileId;

  return (
    <div className="centered">
      <div className="panel">
        <h1>🍌 Plantains!</h1>
        <p className="winner">{won ? 'You won!' : `${winnerName} won!`}</p>
        <button onClick={() => navigate('/')}>Back to Home</button>
        <p className="hint">(Rematch is coming soon — for now, start a new room.)</p>
      </div>
    </div>
  );
}
