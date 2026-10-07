import { useEffect, useRef, useState } from 'react';
import { formatDurationMs, isDailyPersonalBest, solversBeatenLabel } from '@plantain/shared';
import type { DailyResultSummary } from '../lib/api.js';

export interface DailyYourGameProps {
  longestWord: string | null;
  /** False while the board's words are still resolving: null `longestWord` alone can't tell
   *  "loading" from "no words". */
  longestWordReady: boolean;
  durationMs: number | null;
  /** null until the solve has been recorded into the local streak. */
  streak: number | null;
  summary: DailyResultSummary | null;
  /** True once the last scheduled summary attempt has landed or failed. */
  summarySettled: boolean;
  shareText: string;
}

/** `value === null` renders a skeleton bar in the value's line, so the tile is already its final
 *  size and nothing shifts when the number lands. */
function DailyStatTile({ label, value, badge }: { label: string; value: string | null; badge?: string | null }) {
  return (
    <div className="stat-tile daily-stat-tile" aria-busy={value === null}>
      {badge && <span className="daily-pb-badge">{badge}</span>}
      <span className="stat-value">{value ?? <span className="skeleton-bar" aria-hidden="true" />}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

/** The daily puzzle's Results "Your game" panel: a 2x2 tile grid plus the nested share box. */
export default function DailyYourGame({
  longestWord,
  longestWordReady,
  durationMs,
  streak,
  summary,
  summarySettled,
  shareText,
}: DailyYourGameProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  async function handleCopy() {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <div className="panel results-earned daily-your-game">
      <h3>Your game</h3>
      <div className="daily-stat-grid">
        <DailyStatTile label="Longest word" value={longestWordReady ? (longestWord ?? '-') : null} />
        <DailyStatTile
          label="Time"
          value={durationMs != null ? formatDurationMs(durationMs) : '-'}
          badge={isDailyPersonalBest(summary) ? 'Personal Best' : null}
        />
        <DailyStatTile label="Day streak" value={streak == null ? null : String(streak)} />
        <DailyStatTile label="Solvers beaten" value={solversBeatenLabel(summary, summarySettled)} />
      </div>
      <section className="daily-share-box" aria-labelledby="daily-share-heading">
        <div className="daily-share-head">
          <h4 id="daily-share-heading" className="daily-share-title">
            Share your result
          </h4>
          <button type="button" className="daily-share-copy" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <pre className="daily-share-text">{shareText}</pre>
        {copyFailed && <p className="error">Couldn't copy automatically. Select the text above instead.</p>}
      </section>
    </div>
  );
}
