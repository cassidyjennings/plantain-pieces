import type { DictionaryConfig, GridState } from '@plantain/shared';
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

async function call<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('No active session');

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new ApiError((body as { error?: string }).error ?? 'REQUEST_FAILED', res.status, body);
  }
  return body as T;
}

export interface CreateRoomResult {
  roomId: string;
  code: string;
  seat: number;
}

export interface JoinRoomResult {
  roomId: string;
  code: string;
  seat: number;
  status: 'lobby' | 'active' | 'finished';
}

export interface MyState {
  rack: string[];
  grid: GridState;
  seat: number;
  tileCount: number;
}

export interface PeelResult {
  ok: true;
  rack: string[];
  bunchCount: number;
}

export interface DumpResult {
  ok: true;
  rack: string[];
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

export const api = {
  createRoom: (displayName: string) =>
    call<CreateRoomResult>('/rooms', { method: 'POST', body: JSON.stringify({ displayName }) }),

  joinRoom: (code: string, displayName: string, spectator = false) =>
    call<JoinRoomResult>('/rooms/join', {
      method: 'POST',
      body: JSON.stringify({ code, displayName, spectator }),
    }),

  setReady: (roomId: string, ready: boolean) =>
    call<{ ok: true }>(`/rooms/${roomId}/ready`, { method: 'POST', body: JSON.stringify({ ready }) }),

  startGame: (roomId: string) =>
    call<{ ok: true }>(`/rooms/${roomId}/start`, { method: 'POST', body: '{}' }),

  getMyState: (roomId: string) => call<MyState>(`/rooms/${roomId}/me`),

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
    call<{ ok: true }>(`/rooms/${roomId}/plantains`, { method: 'POST', body: JSON.stringify({ grid }) }),

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
};
