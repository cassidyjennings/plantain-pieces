import { useState } from 'react';

interface ConfirmDeleteModalProps {
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Typed-confirmation gate before permanent account deletion. The user must type DELETE
 * to enable the button — a deliberate speed bump on an irreversible action. */
export default function ConfirmDeleteModal({ busy, onConfirm, onCancel }: ConfirmDeleteModalProps) {
  const [confirmText, setConfirmText] = useState('');
  const armed = confirmText.trim().toUpperCase() === 'DELETE';

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="Delete account" onClick={(e) => e.stopPropagation()}>
        <h2>Delete account?</h2>
        <p className="hint">
          This permanently removes your profile, stats, achievements, match history, and custom
          dictionaries. This cannot be undone.
        </p>
        <label className="field">
          Type <strong>DELETE</strong> to confirm
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="DELETE"
            autoFocus
          />
        </label>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn-danger" onClick={onConfirm} disabled={!armed || busy}>
            {busy ? 'Deleting…' : 'Delete forever'}
          </button>
        </div>
      </div>
    </div>
  );
}
