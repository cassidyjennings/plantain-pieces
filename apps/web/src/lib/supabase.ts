import { createClient, type Session } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
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
