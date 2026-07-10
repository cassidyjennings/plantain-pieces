import { createClient } from '@supabase/supabase-js';
import type { Env } from './env.js';

/**
 * Service-role client: bypasses RLS entirely. Used for calling the action RPCs
 * (revoked from anon/authenticated) and for reading a player's own rack when
 * validating a submitted grid. Never expose this client or its key to callers.
 */
export function createAdminClient(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Anon-key client: used ONLY to verify a caller's JWT via auth.getUser(jwt).
 * This calls Supabase Auth's user-info endpoint, so it correctly rejects
 * expired/forged/revoked tokens without us reimplementing JWT verification.
 */
export function createAnonClient(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
