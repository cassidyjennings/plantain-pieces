import { create } from 'zustand';
import { type AvatarConfig, DEFAULT_AVATAR_CONFIG, normalizeAvatarConfig } from '@plantain/shared';
import { fetchMyProfile } from '../lib/profile.js';

interface SessionState {
  profileId: string | null;
  displayName: string;
  avatarConfig: AvatarConfig;
  isGuest: boolean;
  authReady: boolean;
  setProfileId: (id: string) => void;
  setDisplayName: (name: string) => void;
  setAvatarConfig: (config: AvatarConfig) => void;
  /** Load the persisted profile (name/avatar/guest status) from the server after auth.
   * A returning guest who typed a name last session but whose profile still holds the
   * auto 'Guest-xxxx' default keeps the locally-cached name. */
  hydrateProfile: () => Promise<void>;
}

const STORAGE_KEY = 'plantain-display-name';
const AUTO_NAME = /^Guest-[0-9a-f]{4}$/i;

export const useSessionStore = create<SessionState>((set, get) => ({
  profileId: null,
  displayName: localStorage.getItem(STORAGE_KEY) ?? '',
  avatarConfig: DEFAULT_AVATAR_CONFIG,
  isGuest: true,
  authReady: false,
  setProfileId: (id) => set({ profileId: id, authReady: true }),
  setDisplayName: (name) => {
    localStorage.setItem(STORAGE_KEY, name);
    set({ displayName: name });
  },
  setAvatarConfig: (config) => set({ avatarConfig: normalizeAvatarConfig(config) }),
  hydrateProfile: async () => {
    const profile = await fetchMyProfile();
    if (!profile) return;
    const cached = get().displayName.trim();
    const serverName = profile.display_name;
    // Prefer a real server-set name; otherwise keep a locally-cached user choice.
    const displayName = AUTO_NAME.test(serverName) && cached ? cached : serverName;
    set({
      displayName,
      avatarConfig: normalizeAvatarConfig(profile.avatar_config),
      isGuest: profile.is_guest,
    });
  },
}));
