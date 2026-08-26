import type { AvatarConfig, DictionaryConfig, GameSummary, GridState, SoloModeConfig } from '@plantain/shared';
import { supabase } from './supabase.js';

const API_URL = import.meta.env.VITE_API_URL;

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
  }
}

/** The real error message for an error-banner fallback: `ApiError`/`Error` messages (server
 * rejection text, or the browser's own "Failed to fetch"/"Load failed"/"NetworkError...") are
 * far more diagnosable than a hardcoded "Failed to X" — use the real one whenever there is one. */
export function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

async function call<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { data, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw new Error(`Could not read session: ${sessionError.message}`);
  const token = data.session?.access_token;
  if (!token) throw new Error('No active session — guest sign-in may have failed or been blocked');

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    });
  } catch (err) {
    throw new Error(`Could not reach server: ${err instanceof Error ? err.message : String(err)}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(`Server returned an invalid response (status ${res.status})`, res.status, null);
  }
  if (!res.ok) {
    throw new ApiError((body as { error?: string }).error ?? `Request failed (status ${res.status})`, res.status, body);
  }
  return body as T;
}

export interface CreateRoomResult {
  roomId: string;
  code: string;
  seat: number;
}

export interface CreateSoloRoomResult {
  roomId: string;
  code: string;
  seat: number;
  status: 'active';
}

export interface JoinRoomResult {
  roomId: string;
  code: string;
  seat: number;
  status: 'lobby' | 'active' | 'finished';
}

export interface MyState {
  rack: string[];
  rackVersion: number;
  grid: GridState;
  seat: number;
  tileCount: number;
}

export interface PeelResult {
  ok: true;
  rack: string[];
  rackVersion: number;
  bunchCount: number;
}

export interface DumpResult {
  ok: true;
  rack: string[];
  rackVersion: number;
  bunchCount: number;
}

export interface WordSetResult {
  id: string;
  name: string;
  wordCount: number;
}

export interface DictionaryPresetResult {
  id: string;
  name: string;
  config: DictionaryConfig;
  createdAt: string;
}

export interface ProfileResult {
  id: string;
  displayName: string;
  isGuest: boolean;
  avatarConfig: AvatarConfig;
}

export const api = {
  createRoom: (displayName: string, dictionaryConfig?: DictionaryConfig) =>
    call<CreateRoomResult>('/rooms', {
      method: 'POST',
      body: JSON.stringify({ displayName, dictionaryConfig }),
    }),

  createSoloRoom: (displayName: string, dictionaryConfig: DictionaryConfig, modeConfig: SoloModeConfig) =>
    call<CreateSoloRoomResult>('/rooms/solo', {
      method: 'POST',
      body: JSON.stringify({ displayName, dictionaryConfig, modeConfig }),
    }),

  joinRoom: (code: string, displayName: string, spectator = false) =>
    call<JoinRoomResult>('/rooms/join', {
      method: 'POST',
      body: JSON.stringify({ code, displayName, spectator }),
    }),

  setReady: (roomId: string, ready: boolean) =>
    call<{ ok: true }>(`/rooms/${roomId}/ready`, { method: 'POST', body: JSON.stringify({ ready }) }),

  startGame: (roomId: string) =>
    call<{ ok: true }>(`/rooms/${roomId}/start`, { method: 'POST', body: '{}' }),

  leaveRoom: (roomId: string) =>
    call<{ ok: true; newHostId?: string; roomDeleted?: boolean }>(`/rooms/${roomId}/leave`, {
      method: 'POST',
      body: '{}',
    }),

  /** Reset this finished room back to a lobby — same room id, same code, same players.
   * `alreadyReset` means another player got there first, which is a success, not an error. */
  rematchRoom: (roomId: string) =>
    call<{ roomId: string; code: string; alreadyReset: boolean }>(`/rooms/${roomId}/rematch`, {
      method: 'POST',
      body: '{}',
    }),

  getMyState: (roomId: string) => call<MyState>(`/rooms/${roomId}/me`),

  /** Persist this player's final board to the room so the post-game viewer can show it. The
   * room owns it — it's deleted along with the room, never archived. */
  persistFinalGrid: (roomId: string, grid: GridState) =>
    call<{ ok: true }>(`/rooms/${roomId}/final-grid`, {
      method: 'POST',
      body: JSON.stringify({ grid }),
    }),

  reportProgress: (roomId: string, remaining: number) =>
    call<{ ok: true }>(`/rooms/${roomId}/progress`, {
      method: 'POST',
      body: JSON.stringify({ remaining }),
    }),

  peel: (roomId: string, grid: GridState) =>
    call<PeelResult>(`/rooms/${roomId}/peel`, { method: 'POST', body: JSON.stringify({ grid }) }),

  dump: (roomId: string, tile: string) =>
    call<DumpResult>(`/rooms/${roomId}/dump`, { method: 'POST', body: JSON.stringify({ tile }) }),

  validate: (roomId: string, words: string[]) =>
    call<{ invalidWords: string[] }>(`/rooms/${roomId}/validate`, {
      method: 'POST',
      body: JSON.stringify({ words }),
    }),

  plantains: (roomId: string, grid: GridState) =>
    call<{ ok: true }>(`/rooms/${roomId}/plantains`, {
      method: 'POST',
      body: JSON.stringify({ grid }),
    }),

  createWordSet: (name: string, words: string[]) =>
    call<WordSetResult>('/dictionaries/sets', { method: 'POST', body: JSON.stringify({ name, words }) }),

  updateWordSet: (setId: string, name: string, words: string[]) =>
    call<WordSetResult>(`/dictionaries/sets/${setId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, words }),
    }),

  deleteWordSet: (setId: string) =>
    call<{ ok: true }>(`/dictionaries/sets/${setId}`, { method: 'DELETE' }),

  savePreset: (name: string, config: DictionaryConfig) =>
    call<DictionaryPresetResult>('/dictionaries/presets', {
      method: 'POST',
      body: JSON.stringify({ name, config }),
    }),

  deletePreset: (presetId: string) =>
    call<{ ok: true }>(`/dictionaries/presets/${presetId}`, { method: 'DELETE' }),

  setDictionaryConfig: (roomId: string, config: DictionaryConfig) =>
    call<{ ok: true; config: DictionaryConfig }>(`/rooms/${roomId}/dictionary`, {
      method: 'PATCH',
      body: JSON.stringify({ config }),
    }),

  getRoomDictionarySetNames: (roomId: string) =>
    call<{ sets: { id: string; name: string }[] }>(`/rooms/${roomId}/dictionary/set-names`),

  updateProfile: (patch: { displayName?: string; avatarConfig?: AvatarConfig }) =>
    call<ProfileResult>('/profile', { method: 'PATCH', body: JSON.stringify(patch) }),

  setXtinaEnabled: (enabled: boolean) =>
    call<{ ok: true; enabled: boolean }>('/profile/xtina', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  exportMyData: () => call<Record<string, unknown>>('/profile/export'),

  deleteAccount: () => call<{ ok: true }>('/profile', { method: 'DELETE' }),

  /** Roll this player's words/move stats into their lifetime profile stats. Keyed by room —
   * nothing per-game is stored, so the room is the only handle that exists. Returns this
   * game's derived numbers so Results can show them without any per-game row to read back. */
  submitGameSummary: (roomId: string, summary: GameSummary) =>
    call<{ ok: true; longestWord: string | null; rarestWord: string | null; wordCount: number }>(
      `/rooms/${roomId}/summary`,
      { method: 'POST', body: JSON.stringify(summary) },
    ),
};
