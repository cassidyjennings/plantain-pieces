const STORAGE_KEY = 'daily-streak';

interface StreakState {
  dates: string[]; // UTC dates (YYYY-MM-DD) solved, sorted ascending
  lastResult?: {
    date: string;
    roomId?: string;
    durationMs: number;
    longestWord: string | null;
  };
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// UTC arithmetic to match todayISO() and the server's scheduled_date; a local-midnight parse
// shifts the day for anyone east of UTC and silently breaks their streak.
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
  return load().dates.includes(todayISO());
}

/** Consecutive days ending at today (or yesterday if today's not solved yet). */
export function currentStreak(): number {
  const dates = sortedDates();
  const last = dates[dates.length - 1];
  const today = todayISO();
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

export function recordSolved(): void {
  const state = load();
  const today = todayISO();
  if (!state.dates.includes(today)) {
    state.dates.push(today);
    state.dates.sort();
  }
  save(state);
}

export function recordDailyResult(roomId: string, durationMs: number, longestWord: string | null): void {
  const state = load();
  state.lastResult = { date: todayISO(), roomId, durationMs, longestWord };
  save(state);
}

export function getLastResult(): StreakState['lastResult'] {
  return load().lastResult;
}

/** The room today's solve happened in, so Home can reopen its results. */
export function solvedTodayRoomId(): string | null {
  const { dates, lastResult } = load();
  const today = todayISO();
  return dates.includes(today) && lastResult?.date === today ? (lastResult.roomId ?? null) : null;
}
