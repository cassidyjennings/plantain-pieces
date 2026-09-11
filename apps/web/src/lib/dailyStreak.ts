const STORAGE_KEY = 'daily-streak';

interface StreakState {
  dates: string[]; // puzzle dates (YYYY-MM-DD) solved, sorted ascending
  lastResult?: {
    date: string; // the puzzle's date, not the clock's
    roomId?: string;
    durationMs: number;
    longestWord: string | null;
  };
}

/** The player's own calendar date. The daily puzzle rolls over at their local midnight. */
export function localDateISO(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Pure calendar arithmetic on a YYYY-MM-DD string. Parsed as UTC only so a DST change can't land
// the result on the wrong day; the string itself is already a local date.
function prevDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function load(): StreakState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { dates: [] };
    return JSON.parse(raw) as StreakState;
  } catch {
    return { dates: [] };
  }
}

function save(state: StreakState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // private mode or quota — silently skip
  }
}

function sortedDates(): string[] {
  return [...new Set(load().dates)].sort();
}

export function isSolvedToday(): boolean {
  return load().dates.includes(localDateISO());
}

/** Consecutive days ending at today (or yesterday if today's not solved yet). */
export function currentStreak(): number {
  const dates = sortedDates();
  const last = dates[dates.length - 1];
  const today = localDateISO();
  if (!last || (last !== today && last !== prevDay(today))) return 0;
  let count = 1;
  for (let i = dates.length - 2; i >= 0 && dates[i] === prevDay(dates[i + 1]); i--) count++;
  return count;
}

export function bestStreak(): number {
  const dates = sortedDates();
  let best = 0;
  let run = 0;
  for (let i = 0; i < dates.length; i++) {
    run = i > 0 && prevDay(dates[i]) === dates[i - 1] ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

export function totalSolved(): number {
  return sortedDates().length;
}

/** Records a solve under the puzzle's own date rather than the clock's, so a puzzle started
 * before midnight and finished after still counts for the day it belongs to. */
export function recordSolved(puzzleDate: string): void {
  const state = load();
  if (!state.dates.includes(puzzleDate)) {
    state.dates.push(puzzleDate);
    state.dates.sort();
  }
  save(state);
}

export function recordDailyResult(
  puzzleDate: string,
  roomId: string,
  durationMs: number,
  longestWord: string | null,
): void {
  const state = load();
  // Reopening an older daily room's results must not replace a newer day's.
  if (state.lastResult && state.lastResult.date > puzzleDate) return;
  state.lastResult = { date: puzzleDate, roomId, durationMs, longestWord };
  save(state);
}

export function getLastResult(): StreakState['lastResult'] {
  return load().lastResult;
}

/** The room today's solve happened in, so Home can reopen its results. */
export function solvedTodayRoomId(): string | null {
  const { dates, lastResult } = load();
  const today = localDateISO();
  return dates.includes(today) && lastResult?.date === today ? (lastResult.roomId ?? null) : null;
}
