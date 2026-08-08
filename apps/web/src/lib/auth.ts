import type { UserIdentity } from '@supabase/supabase-js';
import { supabase, ensureSession } from './supabase.js';
import { clearCachedDisplayName } from '../store/sessionStore.js';

/** OAuth guest→account upgrade + sign-out helpers. Providers are config-gated in
 * supabase/config.toml — when a provider is disabled (e.g. locally, with no real
 * credentials), linkIdentity rejects and the caller surfaces a friendly message.
 * Only Google is offered — Apple Sign In requires a paid Apple Developer account,
 * which this project intentionally does not use. */

export type UpgradeProvider = 'google';

/** One-shot marker: a link attempt failed server-side and we already spent a fallback sign-in
 * recovering from it. Lives in sessionStorage (it must survive the OAuth redirect, which is a
 * real navigation) and so ALSO survives the same-tab reload that sign-out performs — which is
 * why every deliberate sign-in click and every sign-out has to reset it. Leaving it set turns
 * the next failed link into a raw "identity already exists" error with no recovery path. */
const OAUTH_FALLBACK_GUARD_KEY = 'plantain-oauth-fallback-attempted';

export function markOAuthFallbackAttempted(): void {
  sessionStorage.setItem(OAUTH_FALLBACK_GUARD_KEY, '1');
}

export function oauthFallbackAttempted(): boolean {
  return sessionStorage.getItem(OAUTH_FALLBACK_GUARD_KEY) !== null;
}

export function clearOAuthFallbackGuard(): void {
  sessionStorage.removeItem(OAUTH_FALLBACK_GUARD_KEY);
}

/** Sign out the current session, then immediately start a fresh anonymous guest
 * session (the app always requires a session). Returns the new guest's profile id. */
export async function signOut(): Promise<string> {
  await supabase.auth.signOut();
  // The next session is a brand-new anonymous guest, so drop every piece of per-origin auth
  // scratch state that would otherwise be inherited across the identity boundary: the cached
  // display name (the signed-out account's name showing up on the guest) and the fallback
  // guard (making the next sign-in attempt dead-end on a raw link error).
  clearCachedDisplayName();
  clearOAuthFallbackGuard();
  const session = await ensureSession();
  return session.user.id;
}

/** The identities linked to the current auth user. A pure guest has none (anonymous
 * users carry no identity row); a linked account has a google identity. */
export async function getLinkedIdentities(): Promise<UserIdentity[]> {
  const { data, error } = await supabase.auth.getUserIdentities();
  if (error || !data) return [];
  return data.identities.filter((i) => i.provider !== 'anonymous');
}

/** Begin the OAuth link flow. On success the browser is redirected to the provider and
 * back; the linked identity attaches to the SAME auth user id, so all progress (stats,
 * achievements, dictionaries) carries over. Throws with a friendly message when the
 * provider isn't configured. */
export async function upgradeWith(provider: UpgradeProvider): Promise<void> {
  const { error } = await supabase.auth.linkIdentity({
    provider,
    options: { redirectTo: `${window.location.origin}/profile` },
  });
  if (error) {
    // Surface the real reason (e.g. provider disabled, manual linking off, or a stale/invalid
    // local session referring to a deleted user) instead of a one-size-fits-all message.
    throw new Error(`Couldn't start Google sign-in: ${error.message}`);
  }
}

/** Sign in directly as whichever account this Google identity is already linked to (as
 * opposed to `upgradeWith`, which attaches Google to the CURRENT guest — that fails when
 * the identity already belongs to a different account, e.g. a returning user on a fresh
 * guest session). */
export async function signInWith(provider: UpgradeProvider): Promise<void> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${window.location.origin}/profile` },
  });
  if (error) {
    throw new Error(`Couldn't start Google sign-in: ${error.message}`);
  }
}

/** Supabase's OAuth callback reports a server-side failure (wrong provider config, or —
 * the common one here — trying to link a Google identity that's already attached to a
 * DIFFERENT account) by appending `error`/`error_code`/`error_description` to the
 * `redirectTo` URL instead of session tokens. supabase-js's own URL processing only looks
 * for tokens, so it silently ignores these; without reading them ourselves, a failed
 * link-attempt looks like nothing happened at all. Call once on app boot. */
export function consumeOAuthRedirectError(): { code: string | null; message: string } | null {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const search = new URLSearchParams(window.location.search);
  const code = hash.get('error_code') ?? search.get('error_code');
  const description = hash.get('error_description') ?? search.get('error_description');
  const error = hash.get('error') ?? search.get('error');
  if (!error && !description) return null;
  // Strip the error params so a reload doesn't re-surface a stale error.
  window.history.replaceState(null, '', window.location.pathname);
  return { code, message: (description ?? error ?? 'Sign-in failed').replace(/\+/g, ' ') };
}
