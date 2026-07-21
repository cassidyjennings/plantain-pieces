import { useMemo, useState } from 'react';
import { normalizeWordList, splitWordInput, MAX_WORDS_PER_SET, MAX_SET_NAME_LENGTH } from '@plantain/shared';

interface WordSetEditorProps {
  initialName: string;
  initialWords: string[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (name: string, words: string[]) => void;
}

/** Paste/type words freeform (comma, space, or newline separated) — live-normalized so the
 * writer sees exactly what will be saved (and what got skipped) before committing. */
export default function WordSetEditor({
  initialName,
  initialWords,
  busy,
  error,
  onCancel,
  onSave,
}: WordSetEditorProps) {
  const [name, setName] = useState(initialName);
  const [rawText, setRawText] = useState(initialWords.join('\n'));

  const { words, rejected } = useMemo(() => normalizeWordList(splitWordInput(rawText)), [rawText]);
  const overLimit = words.length > MAX_WORDS_PER_SET;
  const canSave = name.trim().length > 0 && words.length > 0 && !overLimit && !busy;

  return (
    <div className="word-set-editor">
      <label className="field">
        Dictionary name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Family Nicknames"
          maxLength={MAX_SET_NAME_LENGTH}
        />
      </label>

      <label className="field">
        Words <span className="hint">(paste a list: commas, spaces, or new lines all work)</span>
        <textarea
          className="word-set-textarea"
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          placeholder="ORBIT, COMET, NEBULA..."
          rows={8}
        />
      </label>

      <div className={`word-set-count${overLimit ? ' over-limit' : ''}`}>
        {words.length} word{words.length === 1 ? '' : 's'}
        {overLimit && ` (max ${MAX_WORDS_PER_SET})`}
      </div>

      {rejected.length > 0 && (
        <p className="hint word-set-rejected">
          Skipped (letters only, 2–20 chars): {rejected.slice(0, 8).join(', ')}
          {rejected.length > 8 ? `, +${rejected.length - 8} more` : ''}
        </p>
      )}

      {error && <p className="error">{error}</p>}

      <div className="word-set-editor-actions">
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" disabled={!canSave} onClick={() => onSave(name.trim(), words)}>
          Save Dictionary
        </button>
      </div>
    </div>
  );
}
