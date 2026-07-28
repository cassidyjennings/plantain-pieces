import type { DictionaryConfig } from '@plantain/shared';
import {
  STANDARD_DICTIONARY_LABEL,
  withSetIncluded,
  withStandardIncluded,
  type CustomWordSetSummary,
  type OfficialWordSet,
} from '../lib/dictionaries.js';

interface DictionaryChecklistProps {
  config: DictionaryConfig;
  onChange: (config: DictionaryConfig) => void;
  /** The viewer's own dictionaries. */
  mySets: CustomWordSetSummary[];
  /** The built-in language dictionaries, selectable by everyone. */
  officialSets?: OfficialWordSet[];
  /** Read-only viewers (non-host players) see the wordlist as a summary they can't edit. */
  readOnly?: boolean;
  /** Resolves a set id to a name, including sets the viewer doesn't own (e.g. the host's). */
  nameFor: (id: string) => string;
}

const formatCount = (n: number) => `${n.toLocaleString()} words`;

/**
 * A wordlist is just a flat set of one or more dictionaries — any of the built-in languages
 * and/or any of your own — with no "base" distinction; the accepted words are simply the union of
 * whatever's checked. At least one must be selected (enforced by validateDictionaryConfig's
 * NO_WORD_SOURCE check).
 *
 * English is checkbox-bound to `config.baseEnabled` while the other languages are bound to
 * `customSetIds`, because English is stored as the custom_set_id IS NULL partition of `words`
 * rather than as a set row. That's purely a storage detail, so both render as ordinary rows in
 * one "Languages" group.
 */
export default function DictionaryChecklist({
  config,
  onChange,
  mySets,
  officialSets = [],
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

      <h4 className="journal-set-group">Languages</h4>
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
        {officialSets.map((set) => (
          <li key={set.id} className="journal-set-row">
            <input
              type="checkbox"
              checked={config.customSetIds.includes(set.id)}
              onChange={(e) => onChange(withSetIncluded(config, set.id, e.target.checked))}
              aria-label={`Include ${set.name}`}
            />
            <span className="journal-set-name">{set.name}</span>
            <span className="journal-set-count">{formatCount(set.word_count)}</span>
          </li>
        ))}
      </ul>

      <h4 className="journal-set-group">Your dictionaries</h4>
      {mySets.length === 0 ? (
        <p className="hint">You don't have any dictionaries yet. Make one to add it here.</p>
      ) : (
        <ul className="journal-set-list">
          {mySets.map((set) => (
            <li key={set.id} className="journal-set-row">
              <input
                type="checkbox"
                checked={config.customSetIds.includes(set.id)}
                onChange={(e) => onChange(withSetIncluded(config, set.id, e.target.checked))}
                aria-label={`Include ${set.name}`}
              />
              <span className="journal-set-name">{set.name}</span>
              <span className="journal-set-count">{formatCount(set.word_count)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
