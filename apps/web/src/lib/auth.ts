import type { UserIdentity } from '@supabase/supabase-js';
import { supabase, ensureSession } from './supabase.js';

/** OAuth guest→account upgrade + sign-out helpers. Providers are config-gated in
 * supabase/config.toml — when a provider is disabled (e.g. locally, with no real
 * credentials), linkIdentity rejects and the caller surfaces a friendly message.
 * Only Google is offered — Apple Sign In requires a paid Apple Developer account,
 * which this project intentionally does not use. */

export type UpgradeProvider = 'google';

/** Sign out the current session, then immediately start a fresh anonymous guest
 * session (the app always requires a session). Returns the new guest's profile id. */
export async function signOut(): Promise<string> {
  await supabase.auth.signOut();
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
    // Provider disabled / not configured, or manual linking off — surface plainly.
    throw new Error(`Couldn't start Google sign-in. This deployment may not have it configured yet.`);
  }
}
