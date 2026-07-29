import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Assembles a full export of a user's own data, read with the service-role client. Used by
 * GET /profile/export; the client turns the returned object into a downloadable JSON file.
 * Only ever reads rows belonging to p_profile.
 */
export async function assembleExport(admin: SupabaseClient, profileId: string) {
  // No match history: per-game rows aren't stored at all any more (migration 20260728000006).
  // Everything a game contributed lives in the profile_stats aggregate below.
  const [profile, stats, achievements, customSets, presets] = await Promise.all([
    admin.from('profiles').select('id, display_name, is_guest, avatar_config, created_at, current_streak, longest_streak, last_played_date').eq('id', profileId).single(),
    admin.from('profile_stats').select('*').eq('profile_id', profileId),
    admin.from('achievements').select('type, earned_at, meta').eq('user_id', profileId),
    admin.from('custom_word_sets').select('id, name, created_at').eq('owner_id', profileId),
    admin.from('dictionary_presets').select('id, name, config, created_at').eq('owner_id', profileId),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    profile: profile.data ?? null,
    // One row per mode (multiplayer / solo), so an array rather than a single object.
    stats: stats.data ?? [],
    achievements: achievements.data ?? [],
    customWordSets: customSets.data ?? [],
    dictionaryPresets: presets.data ?? [],
  };
}
