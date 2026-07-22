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
 *
 * Waits for the SDK's own `INITIAL_SESSION` event rather than calling `getSession()`
 * directly. supabase-js processes an OAuth redirect's `#access_token=...` hash
 * asynchronously in the background right after the client is created (via
 * `detectSessionInUrl`); calling `getSession()` immediately can race ahead of that and
 * see no session yet, right after a real one was just established (e.g. returning from
 * "Sign in with Google") — which then mints a throwaway new guest and orphans the
 * identity that was just linked. `INITIAL_SESSION` fires exactly once, only after that
 * initial resolution (redirect-hash included) has completed.
 */
export async function ensureSession(): Promise<Session> {
  const session = await new Promise<Session | null>((resolve) => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION') {
        subscription.unsubscribe();
        resolve(session);
      }
    });
  });
  if (session) return session;

  const { data: signInData, error } = await supabase.auth.signInAnonymously();
  if (error || !signInData.session) {
    throw new Error(error?.message ?? 'Failed to start a guest session');
  }
  return signInData.session;
}
