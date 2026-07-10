import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ensureSession } from './lib/supabase.js';
import { useSessionStore } from './store/sessionStore.js';
import Home from './pages/Home.js';
import Lobby from './pages/Lobby.js';
import Game from './pages/Game.js';
import Results from './pages/Results.js';

export default function App() {
  const [error, setError] = useState<string | null>(null);
  const authReady = useSessionStore((s) => s.authReady);
  const setProfileId = useSessionStore((s) => s.setProfileId);

  useEffect(() => {
    ensureSession()
      .then((session) => setProfileId(session.user.id))
      .catch((err) => setError(err.message));
  }, [setProfileId]);

  if (error) return <div className="centered">Failed to start session: {error}</div>;
  if (!authReady) return <div className="centered">Loading Plantain Pieces...</div>;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/room/:roomId" element={<Lobby />} />
        <Route path="/room/:roomId/game" element={<Game />} />
        <Route path="/room/:roomId/results" element={<Results />} />
      </Routes>
    </BrowserRouter>
  );
}
