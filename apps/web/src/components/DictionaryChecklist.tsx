import type { DictionaryConfig } from '@plantain/shared';
import {
  STANDARD_DICTIONARY_LABEL,
  withSetIncluded,
  withStandardIncluded,
  type CustomWordSetSummary,
} from '../lib/dictionaries.js';

interface DictionaryChecklistProps {
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
 * A wordlist is just a flat set of one or more dictionaries — the built-in list and/or any of
 * your own — with no "base" distinction; the accepted words are simply the union of whatever's
 * checked. At least one must be selected (enforced by validateDictionaryConfig's NO_WORD_SOURCE
 * check).
 */
export default function DictionaryChecklist({
  config,
  onChange,
  mySets,
  readOnly = false,
  nameFor,
}: DictionaryChecklistProps) {
  const includedNames = [
    ...(config.baseEnabled ? [STANDARD_DICTIONARY_LABEL] : []),
    ...config.customSetIds.map(nameFor),
  ];

  if (readOnly) {
    return (
      <div className="journal-section">
        <h3>Dictionaries</h3>
        <p className="wordlist-readonly-value">
          {includedNames.length > 0 ? includedNames.join(', ') : 'None'}
        </p>
      </div>
    );
  }

  return (
    <div className="journal-section">
      <h3>Dictionaries</h3>
      <p className="hint">Pick at least one word source.</p>
      <ul className="journal-set-list">
        <li className="journal-set-row">
          <input
            type="checkbox"
            checked={config.baseEnabled}
            onChange={(e) => onChange(withStandardIncluded(config, e.target.checked))}
            aria-label={`Include ${STANDARD_DICTIONARY_LABEL}`}
          />
          <span className="journal-set-name">{STANDARD_DICTIONARY_LABEL}</span>
        </li>
        {mySets.map((set) => (
          <li key={set.id} className="journal-set-row">
            <input
              type="checkbox"
              checked={config.customSetIds.includes(set.id)}
              onChange={(e) => onChange(withSetIncluded(config, set.id, e.target.checked))}
              aria-label={`Include ${set.name}`}
            />
            <span className="journal-set-name">{set.name}</span>
            <span className="journal-set-count">{set.word_count} words</span>
          </li>
        ))}
      </ul>
      {mySets.length === 0 && (
        <p className="hint">You don't have any dictionaries yet. Make one to add it here.</p>
      )}
    </div>
  );
}
