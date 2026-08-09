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
 * Holds the bootstrap while it runs, so two concurrent callers share one instead of each
 * minting their own anonymous user.
 *
 * React 18's StrictMode double-invokes mount effects in dev, so App's boot effect called
 * ensureSession() twice in the same tick. Both awaited `INITIAL_SESSION`, both saw `null`,
 * and both ran `signInAnonymously()` — producing two `auth.users` rows (and two `profiles`
 * rows) milliseconds apart, with the second session silently replacing the first inside
 * this module's shared `supabase` client. The visible symptom was three `406 Not
 * Acceptable` (PGRST116, "The result contains 0 rows") responses on `/profile`:
 * `fetchMyProfile()` resolves the id via an awaited `getUser()` and then issues the row
 * query as a separate await, so the filtered id could still be user A while the attached
 * JWT had already become user B — and `profiles_select_own` (`id = auth.uid()`) then
 * matches nothing.
 *
 * StrictMode made it reproducible, but this is not merely a dev artifact: signOut() also
 * calls ensureSession(), so any overlap with the boot call raced the same way in prod, and
 * every extra anonymous user is a real row that only the 10-day guest sweep collects.
 */
let inFlightSession: Promise<Session> | null = null;

/**
 * Guest-first bootstrap: reuse a persisted session if one exists, otherwise sign in
 * anonymously. Safe to call concurrently — overlapping callers share one bootstrap.
 */
export function ensureSession(): Promise<Session> {
  // Dedupe only while a bootstrap is IN FLIGHT — deliberately not a permanent cache.
  // signOut() calls this again on purpose to mint a brand-new guest, and that call is
  // sequential (it awaits supabase.auth.signOut() first), so by then the slot is clear
  // and it gets a genuine fresh bootstrap. Only truly concurrent callers share.
  if (!inFlightSession) {
    inFlightSession = bootstrapSession();
    // Clear the slot once settled, whether it resolved or threw, so a failed boot can be
    // retried rather than every later caller inheriting the same rejected promise.
    void inFlightSession.finally(() => {
      inFlightSession = null;
    });
  }
  return inFlightSession;
}

/**
 * Waits for the SDK's own `INITIAL_SESSION` event rather than calling `getSession()`
 * directly. supabase-js processes an OAuth redirect's `#access_token=...` hash
 * asynchronously in the background right after the client is created (via
 * `detectSessionInUrl`); calling `getSession()` immediately can race ahead of that and
 * see no session yet, right after a real one was just established (e.g. returning from
 * "Sign in with Google") — which then mints a throwaway new guest and orphans the
 * identity that was just linked. `INITIAL_SESSION` fires exactly once, only after that
 * initial resolution (redirect-hash included) has completed.
 */
async function bootstrapSession(): Promise<Session> {
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
