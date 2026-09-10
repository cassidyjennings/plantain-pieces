const STORAGE_KEY = 'daily-streak';

interface StreakState {
  dates: string[];  // ISO dates (YYYY-MM-DD) solved, sorted ascending
  lastResult?: {
    date: string;
    durationMs: number;
    longestWord: string | null;
  };
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
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

export function isSolvedToday(): boolean {
  return load().dates.includes(todayISO());
}

/** Consecutive days ending at today (or yesterday if today's not solved yet). */
export function currentStreak(): number {
  const { dates } = load();
  if (dates.length === 0) return 0;
  const sorted = [...dates].sort();

  const today = todayISO();
  const yesterday = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const last = sorted[sorted.length - 1];
  if (last !== today && last !== yesterday) return 0;

  let count = 1;
  let prev = last;
  for (let i = sorted.length - 2; i >= 0; i--) {
    const expected = (() => {
      const d = new Date(prev + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      return d.toISOString().slice(0, 10);
    })();
    if (sorted[i] === expected) {
      count++;
      prev = sorted[i];
    } else {
      break;
    }
  }
  return count;
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

export function recordDailyResult(durationMs: number, longestWord: string | null): void {
  const state = load();
  state.lastResult = { date: todayISO(), durationMs, longestWord };
  save(state);
}

export function getLastResult(): StreakState['lastResult'] {
  return load().lastResult;
}
