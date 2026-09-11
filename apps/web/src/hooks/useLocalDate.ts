import { useEffect, useState } from 'react';
import { localDateISO } from '../lib/dailyStreak.js';

/** The player's local date, re-rendering the caller when it changes: a timer set for the next
 * midnight, plus a re-check whenever the tab becomes visible again, since a sleeping laptop or a
 * throttled background tab can fire that timer late or not at all. */
export function useLocalDate(): string {
  const [date, setDate] = useState(localDateISO);

  useEffect(() => {
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timer = setTimeout(() => setDate(localDateISO()), nextMidnight.getTime() - now.getTime() + 1000);
    const recheck = () => {
      if (document.visibilityState === 'visible') setDate(localDateISO());
    };
    document.addEventListener('visibilitychange', recheck);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [date]);

  return date;
}
