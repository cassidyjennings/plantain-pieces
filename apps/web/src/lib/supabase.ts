import { createClient, type Session } from '@supabase/supabase-js';

/**
 * `sessionStorage`, not the default `localStorage`: a guest's anonymous session must stay
 * scoped to one browser tab. With `localStorage` (shared across all tabs of the same origin),
 * opening a second tab to join a room you just created in the first tab silently resumes the
 * SAME guest identity — "Join" just re-associates you with your own host seat instead of
 * adding a second player, which looks like joining does nothing. `sessionStorage` still
 * persists a reload within a tab, but a new tab always starts a fresh anonymous session.
 */
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      storage: window.sessionStorage,
    },
  },
);

if (import.meta.env.DEV) {
  (window as unknown as { supabase: typeof supabase }).supabase = supabase;
}

/**
 * Guest-first bootstrap: reuse a persisted session if one exists, otherwise
 * sign in anonymously. Called once at app startup.
 */
export async function ensureSession(): Promise<Session> {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;

  const { data: signInData, error } = await supabase.auth.signInAnonymously();
  if (error || !signInData.session) {
    throw new Error(error?.message ?? 'Failed to start a guest session');
  }
  return signInData.session;
}
