import { create } from 'zustand';

interface SessionState {
  profileId: string | null;
  displayName: string;
  authReady: boolean;
  setProfileId: (id: string) => void;
  setDisplayName: (name: string) => void;
}

const STORAGE_KEY = 'plantain-display-name';

export const useSessionStore = create<SessionState>((set) => ({
  profileId: null,
  displayName: localStorage.getItem(STORAGE_KEY) ?? '',
  authReady: false,
  setProfileId: (id) => set({ profileId: id, authReady: true }),
  setDisplayName: (name) => {
    localStorage.setItem(STORAGE_KEY, name);
    set({ displayName: name });
  },
}));
