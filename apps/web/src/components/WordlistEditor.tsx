import { WORD_LENGTH_MAX, type DictionaryConfig } from '@plantain/shared';
import type { CustomWordSetSummary } from '../lib/dictionaries.js';
import WordLengthStepper from './WordLengthStepper.js';
import DictionaryChecklist from './DictionaryChecklist.js';

interface WordlistEditorProps {
  config: DictionaryConfig;
  onChange: (config: DictionaryConfig) => void;
  /** The viewer's own dictionaries — the only ones they can pick. */
  mySets: CustomWordSetSummary[];
  /** Read-only viewers (non-host players) see the wordlist as a summary they can't edit. */
  readOnly?: boolean;
  /** Resolves a set id to a name, including sets the viewer doesn't own (e.g. the host's). */
  nameFor: (id: string) => string;
}

/**
 * A named preset bundles a minimum word length with a dictionary selection, so the preset
 * editor (DictionaryJournal) edits both together. Elsewhere (the Lobby / solo setup pages),
 * length and dictionaries are shown as separate standalone controls instead of through this
 * component — see WordLengthStepper and DictionaryChecklist.
 */
export default function WordlistEditor({
  config,
  onChange,
  mySets,
  readOnly = false,
  nameFor,
}: WordlistEditorProps) {
  const maxMinLength = config.maxLength ?? WORD_LENGTH_MAX;

  if (readOnly) {
    return (
      <>
        <div className="journal-section">
          <h3>Minimum word length</h3>
          <p className="wordlist-readonly-value">{config.minLength}+ letters</p>
        </div>
        <DictionaryChecklist config={config} onChange={onChange} mySets={mySets} readOnly nameFor={nameFor} />
      </>
    );
  }

  return (
    <>
      <div className="journal-section">
        <h3>Minimum word length</h3>
        <WordLengthStepper
          value={config.minLength}
          maxValue={maxMinLength}
          onChange={(minLength) => onChange({ ...config, minLength })}
        />
      </div>
      <DictionaryChecklist config={config} onChange={onChange} mySets={mySets} nameFor={nameFor} />
    </>
  );
}
