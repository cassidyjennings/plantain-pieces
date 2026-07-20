import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Assembles a full export of a user's own data, read with the service-role client. Used by
 * GET /profile/export; the client turns the returned object into a downloadable JSON file.
 * Only ever reads rows belonging to p_profile.
 */
export async function assembleExport(admin: SupabaseClient, profileId: string) {
  const [profile, stats, achievements, matchHistory, customSets, presets] = await Promise.all([
    admin.from('profiles').select('id, display_name, is_guest, avatar_config, created_at').eq('id', profileId).single(),
    admin.from('profile_stats').select('*').eq('profile_id', profileId).maybeSingle(),
    admin.from('achievements').select('type, earned_at, meta').eq('user_id', profileId),
    admin
      .from('game_players')
      .select('game_id, seat, is_winner, final_tile_count, final_placed_count, peels, dumps, first_peel_ms, longest_word, words_played, rarest_word, opponents, created_at')
      .eq('profile_id', profileId)
      .order('created_at', { ascending: false }),
    admin.from('custom_word_sets').select('id, name, created_at').eq('owner_id', profileId),
    admin.from('dictionary_presets').select('id, name, config, created_at').eq('owner_id', profileId),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    profile: profile.data ?? null,
    stats: stats.data ?? null,
    achievements: achievements.data ?? [],
    matchHistory: matchHistory.data ?? [],
    customWordSets: customSets.data ?? [],
    dictionaryPresets: presets.data ?? [],
  };
}
