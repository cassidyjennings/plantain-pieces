import { create } from 'zustand';
import { type AvatarConfig, DEFAULT_AVATAR_CONFIG, normalizeAvatarConfig } from '@plantain/shared';
import { fetchMyProfile } from '../lib/profile.js';

interface SessionState {
  profileId: string | null;
  displayName: string;
  avatarConfig: AvatarConfig;
  isGuest: boolean;
  authReady: boolean;
  xtinaRole: 'owner' | 'partner' | null;
  xtinaEnabled: boolean;
  setProfileId: (id: string) => void;
  setDisplayName: (name: string) => void;
  setAvatarConfig: (config: AvatarConfig) => void;
  setXtinaEnabled: (enabled: boolean) => void;
  /** Load the persisted profile (name/avatar/guest status) from the server after auth.
   * A returning guest who typed a name last session but whose profile still holds the
   * auto 'Guest-xxxx' default keeps the locally-cached name. */
  hydrateProfile: () => Promise<void>;
}

/** Origin-wide (localStorage, NOT sessionStorage) cache of the typed display name. It exists
 * ONLY for guests: auth storage is sessionStorage-scoped, so every new tab mints a new anonymous
 * user with a fresh auto 'Guest-xxxx' profile, and without this a guest would have to retype
 * their name in every tab. A signed-in account persists its name server-side and must never
 * write here — being origin-wide and identity-agnostic, anything left in it is inherited by the
 * NEXT identity on this origin (which is how a signed-out Google account's name used to show up
 * on the fresh guest that replaced it). */
const STORAGE_KEY = 'plantain-display-name';
const AUTO_NAME = /^Guest-[0-9a-f]{4}$/i;

/** Drop the guest name cache. Called on sign-out, before the next anonymous session starts. */
export function clearCachedDisplayName(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export const useSessionStore = create<SessionState>((set, get) => ({
  profileId: null,
  displayName: localStorage.getItem(STORAGE_KEY) ?? '',
  avatarConfig: DEFAULT_AVATAR_CONFIG,
  isGuest: true,
  authReady: false,
  xtinaRole: null,
  xtinaEnabled: false,
  setProfileId: (id) => set({ profileId: id, authReady: true }),
  setDisplayName: (name) => {
    if (get().isGuest) localStorage.setItem(STORAGE_KEY, name);
    else localStorage.removeItem(STORAGE_KEY);
    set({ displayName: name });
  },
  setAvatarConfig: (config) => set({ avatarConfig: normalizeAvatarConfig(config) }),
  setXtinaEnabled: (xtinaEnabled) => set({ xtinaEnabled }),
  hydrateProfile: async () => {
    const profile = await fetchMyProfile();
    if (!profile) return;
    const cached = get().displayName.trim();
    const serverName = profile.display_name;
    // Prefer a real server-set name; otherwise keep a locally-cached user choice — but only for
    // a guest. A linked account's name is authoritative from the server, and letting a stale
    // cache win there would resurrect the name of whoever last used this browser as a guest.
    const displayName = profile.is_guest && AUTO_NAME.test(serverName) && cached ? cached : serverName;
    // Evict the guest-only cache as soon as we know this identity isn't a guest, so the next
    // guest on this origin (a new tab, or the session left behind by signing out) starts clean.
    if (!profile.is_guest) localStorage.removeItem(STORAGE_KEY);
    set({
      displayName,
      avatarConfig: normalizeAvatarConfig(profile.avatar_config),
      isGuest: profile.is_guest,
      xtinaRole: profile.xtina_role ?? null,
      xtinaEnabled: profile.xtina_enabled ?? false,
    });
  },
}));
