import type { DictionaryConfig } from '@plantain/shared';
import {
  ENGLISH_BASE_LABEL,
  getAdditionalSetIds,
  getBaseSource,
  withAdditionalSetIds,
  withBaseSource,
  type CustomWordSetSummary,
} from '../lib/dictionaries.js';

interface WordlistEditorProps {
  config: DictionaryConfig;
  onChange: (config: DictionaryConfig) => void;
  /** The viewer's own dictionaries — the only ones they can pick as a base or add. */
  mySets: CustomWordSetSummary[];
  /** Read-only viewers (non-host players) see the wordlist as a summary they can't edit. */
  readOnly?: boolean;
  /** Resolves a set id to a name, including sets the viewer doesn't own (e.g. the host's). */
  nameFor: (id: string) => string;
}

/**
 * A wordlist is one **base** dictionary plus any number of additional ones. The base can be the
 * built-in English list or any of your own dictionaries — nothing about the base is privileged
 * at validation time (the accepted words are the union either way), it just anchors the list.
 */
export default function WordlistEditor({
  config,
  onChange,
  mySets,
  readOnly = false,
  nameFor,
}: WordlistEditorProps) {
  const base = getBaseSource(config);
  const additional = getAdditionalSetIds(config);

  if (readOnly) {
    return (
      <div className="journal-section">
        <h3>Base dictionary</h3>
        <p className="wordlist-readonly-value">
          {base ? (base.kind === 'english' ? ENGLISH_BASE_LABEL : nameFor(base.id)) : 'None'}
        </p>
        <h3>Added dictionaries</h3>
        <p className="wordlist-readonly-value">
          {additional.length > 0 ? additional.map(nameFor).join(', ') : 'None'}
        </p>
      </div>
    );
  }

  function toggleAdditional(id: string) {
    const next = additional.includes(id)
      ? additional.filter((x) => x !== id)
      : [...additional, id];
    onChange(withAdditionalSetIds(config, next));
  }

  const baseIsCustom = base?.kind === 'custom';

  return (
    <div className="journal-section">
      <h3>Base dictionary</h3>
      <ul className="journal-set-list">
        <li className="journal-set-row">
          <input
            type="radio"
            name="wordlist-base"
            checked={base?.kind === 'english'}
            onChange={() => onChange(withBaseSource(config, { kind: 'english' }))}
            aria-label={`Use ${ENGLISH_BASE_LABEL} as the base`}
          />
          <span className="journal-set-name">{ENGLISH_BASE_LABEL}</span>
          <span className="journal-set-count">ENABLE1 · ~172,000 words</span>
        </li>
        {mySets.map((set) => (
          <li key={set.id} className="journal-set-row">
            <input
              type="radio"
              name="wordlist-base"
              checked={baseIsCustom && base.id === set.id}
              onChange={() => onChange(withBaseSource(config, { kind: 'custom', id: set.id }))}
              aria-label={`Use ${set.name} as the base`}
            />
            <span className="journal-set-name">{set.name}</span>
            <span className="journal-set-count">{set.word_count} words</span>
          </li>
        ))}
      </ul>

      <h3>Add more dictionaries</h3>
      {mySets.length === 0 && (
        <p className="hint">You don't have any dictionaries yet — make one to add it here.</p>
      )}
      <ul className="journal-set-list">
        {mySets
          .filter((set) => !(baseIsCustom && base.id === set.id))
          .map((set) => (
            <li key={set.id} className="journal-set-row">
              <input
                type="checkbox"
                checked={additional.includes(set.id)}
                onChange={() => toggleAdditional(set.id)}
                aria-label={`Add ${set.name}`}
              />
              <span className="journal-set-name">{set.name}</span>
              <span className="journal-set-count">{set.word_count} words</span>
            </li>
          ))}
      </ul>
    </div>
  );
}
