import { useState } from 'react';
import { api, getErrorMessage } from '../lib/api.js';
import { useSessionStore } from '../store/sessionStore.js';

/**
 * The xtina mode on/off button. Renders nothing at all unless this account carries the 'owner'
 * role, so for every other player — including the partner — it does not exist in the DOM.
 * The server re-checks the role in set_xtina_enabled; this is presentation only.
 */
export default function XtinaToggle() {
  const xtinaRole = useSessionStore((s) => s.xtinaRole);
  const enabled = useSessionStore((s) => s.xtinaEnabled);
  const setEnabled = useSessionStore((s) => s.setXtinaEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (xtinaRole !== 'owner') return null;

  async function toggle() {
    const next = !enabled;
    setBusy(true);
    setError(null);
    setEnabled(next); // optimistic
    try {
      const res = await api.setXtinaEnabled(next);
      setEnabled(res.enabled);
    } catch (err) {
      setEnabled(!next); // roll back
      setError(getErrorMessage(err, 'Failed to save'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="profile-section">
      <h3>Xtina mode</h3>
      <p className="hint">When this is on, your next two-player game becomes the scripted one.</p>
      <button
        type="button"
        className={`btn-secondary toggle-btn${enabled ? ' active' : ''}`}
        aria-pressed={enabled}
        disabled={busy}
        onClick={toggle}
      >
        {enabled ? 'On' : 'Off'}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
