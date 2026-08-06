import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  validateStructure,
  validateDictionaryConfig,
  validateDisplayName,
  validateAvatarConfig,
  validateGameSummary,
  validateSoloModeConfig,
  isValidGridShape,
  type GridState,
  type DictionaryConfig,
  type AvatarConfig,
  type GameSummary,
  type SoloModeConfig,
} from '@plantain/shared';
import type { Env } from './env.js';
import { createAdminClient } from './supabase.js';
import { requireAuth } from './auth.js';
import { statusForRpcError } from './rpcError.js';
import { fetchRack } from './gridValidation.js';
import { fetchSelectableCustomSetIds, resolveCustomSetNames } from './dictionaries.js';
import { assembleExport } from './profile.js';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());
app.use('/rooms/*', requireAuth);
app.use('/dictionaries/*', requireAuth);
app.use('/profile', requireAuth);
app.use('/profile/*', requireAuth);

app.get('/', (c) => c.json({ ok: true, service: 'plantain-pieces-api' }));

/** A room's mode, for the handful of routes that must behave differently in xtina mode.
 * Returns null when the room is missing — callers treat that as "not xtina" and let the RPC
 * below them raise the real ROOM_NOT_FOUND. */
async function roomMode(
  admin: ReturnType<typeof createAdminClient>,
  roomId: string,
): Promise<string | null> {
  const { data } = await admin.from('rooms').select('mode').eq('id', roomId).single();
  return (data as { mode?: string } | null)?.mode ?? null;
}

// --- Room lifecycle ---------------------------------------------------------

app.post('/rooms', async (c) => {
  const profileId = c.get('profileId');
  const body = await c.req.json<{ displayName: string; dictionaryConfig?: unknown }>();
  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('create_room', {
    p_host: profileId,
    p_display_name: body.displayName,
    p_config: body.dictionaryConfig ?? null,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

// Solo mode: creates the room, seeds a scaled Bunch, deals the opening hand, and marks it
// active — all in one RPC call. The client skips the Lobby entirely and navigates straight
// into the game, since there's no one else to wait for.
app.post('/rooms/solo', async (c) => {
  const profileId = c.get('profileId');
  const body = await c.req.json<{
    displayName: string;
    dictionaryConfig?: DictionaryConfig;
    modeConfig: SoloModeConfig;
  }>();

  const modeCheck = validateSoloModeConfig(body.modeConfig);
  if (!modeCheck.valid) return c.json({ error: modeCheck.reason }, statusForRpcError(modeCheck.reason));

  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('create_solo_room', {
    p_host: profileId,
    p_display_name: body.displayName,
    p_dictionary_config: body.dictionaryConfig ?? null,
    p_bunch_size: body.modeConfig.bunchSize,
    p_timed: body.modeConfig.timed,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

app.post('/rooms/join', async (c) => {
  const profileId = c.get('profileId');
  const body = await c.req.json<{ code: string; displayName: string; spectator?: boolean }>();
  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('join_room', {
    p_code: body.code,
    p_profile: profileId,
    p_display_name: body.displayName,
    p_spectator: body.spectator ?? false,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

app.post('/rooms/:roomId/ready', async (c) => {
  const profileId = c.get('profileId');
  const roomId = c.req.param('roomId');
  const body = await c.req.json<{ ready: boolean }>();
  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('set_ready', {
    p_room_id: roomId,
    p_profile: profileId,
    p_ready: body.ready,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

// Split!
app.post('/rooms/:roomId/start', async (c) => {
  const profileId = c.get('profileId');
  const roomId = c.req.param('roomId');
  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('start_game', {
    p_room_id: roomId,
    p_host: profileId,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

app.post('/rooms/:roomId/leave', async (c) => {
  const profileId = c.get('profileId');
  const roomId = c.req.param('roomId');
  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('leave_room', {
    p_room_id: roomId,
    p_profile: profileId,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

// Rematch: reset THIS room back to a lobby (same id, same code, same players) rather than
// creating a new one. Idempotent in the RPC, so several players clicking at once all succeed
// and land in the same lobby.
app.post('/rooms/:roomId/rematch', async (c) => {
  const profileId = c.get('profileId');
  const roomId = c.req.param('roomId');
  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('rematch_room', {
    p_room_id: roomId,
    p_profile: profileId,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

app.get('/rooms/:roomId/me', async (c) => {
  const profileId = c.get('profileId');
  const roomId = c.req.param('roomId');
  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('get_my_state', {
    p_room_id: roomId,
    p_profile: profileId,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

// --- In-game actions ---------------------------------------------------------

// Peel!: structural validation happens here (client submits its full grid);
// the RPC only trusts the tile count it validated against.
app.post('/rooms/:roomId/peel', async (c) => {
  const profileId = c.get('profileId');
  const roomId = c.req.param('roomId');
  const body = await c.req.json<{ grid: GridState }>();
  const admin = createAdminClient(c.env);

  let rack;
  try {
    rack = await fetchRack(admin, roomId, profileId);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 403);
  }

  const structural = validateStructure(body.grid, rack);
  if (!structural.valid) {
    return c.json({ error: structural.reason, orphans: structural.orphans }, 400);
  }

  const { data, error } = await admin.rpc('peel', {
    p_room_id: roomId,
    p_profile: profileId,
    p_expected_count: rack.length,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));

  await admin.rpc('persist_grid', { p_room_id: roomId, p_profile: profileId, p_grid: body.grid });
  return c.json(data);
});

// Final board, for the post-game viewer. Persisted onto room_players.grid_state, which is
// ephemeral — it cascades away when the room is deleted. Deliberately NOT archived onto
// game_players: nothing can navigate to a board once the room is gone (Results renders off
// rooms_public), so archiving it would retain player data no one could ever read.
//
// Needed because grid_state is otherwise only written on Peel/Plantains, so for every player
// who didn't win it's stale by the time the game ends.
app.post('/rooms/:roomId/final-grid', async (c) => {
  const profileId = c.get('profileId');
  const roomId = c.req.param('roomId');
  const body = await c.req.json<{ grid: unknown }>();

  if (!isValidGridShape(body.grid)) return c.json({ error: 'MALFORMED_GRID' }, 400);

  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('persist_grid', {
    p_room_id: roomId,
    p_profile: profileId,
    p_grid: body.grid,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

// Progress: the client reports its own private "tiles remaining" number (debounced) so
// opponents' pills mean something. Dedupe/broadcast-on-change lives in the RPC.
app.post('/rooms/:roomId/progress', async (c) => {
  const profileId = c.get('profileId');
  const roomId = c.req.param('roomId');
  const body = await c.req.json<{ remaining: number }>();
  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('report_progress', {
    p_room_id: roomId,
    p_profile: profileId,
    p_remaining: body.remaining,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

// Live validation: which of the submitted words are NOT in the room's dictionary.
// Used by the client for green-highlighting valid words during play (read-only, no mutation).
app.post('/rooms/:roomId/validate', async (c) => {
  const roomId = c.req.param('roomId');
  const body = await c.req.json<{ words: string[] }>();
  const admin = createAdminClient(c.env);
  const words = Array.isArray(body.words) ? body.words : [];
  if (words.length === 0) return c.json({ invalidWords: [] });
  const { data, error } = await admin.rpc('find_invalid_words', {
    p_room_id: roomId,
    p_words: words,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json({ invalidWords: data ?? [] });
});

// Dump!: no grid validation needed, just an owned-tile check performed in SQL.
app.post('/rooms/:roomId/dump', async (c) => {
  const profileId = c.get('profileId');
  const roomId = c.req.param('roomId');
  const body = await c.req.json<{ tile: string }>();
  const admin = createAdminClient(c.env);

  // Dump draws three tiles from the shared Bunch, which would desynchronize the scripted deal
  // and leave the endgame arithmetic unable to land on zero. The client hides the button too;
  // this is the authoritative half.
  if ((await roomMode(admin, roomId)) === 'xtina') {
    return c.json({ error: 'XTINA_NO_DUMP' }, 400);
  }

  const { data, error } = await admin.rpc('dump', {
    p_room_id: roomId,
    p_profile: profileId,
    p_tile: body.tile,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

// Plantains!: full structural + dictionary validation, then end the game.
app.post('/rooms/:roomId/plantains', async (c) => {
  const profileId = c.get('profileId');
  const roomId = c.req.param('roomId');
  const body = await c.req.json<{ grid: GridState }>();
  const admin = createAdminClient(c.env);

  let rack;
  try {
    rack = await fetchRack(admin, roomId, profileId);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 403);
  }

  const structural = validateStructure(body.grid, rack);
  if (!structural.valid) {
    await admin.rpc('append_room_event', {
      p_room_id: roomId,
      p_type: 'plantains_rejected',
      p_payload: { actor: profileId, reason: structural.reason },
    });
    return c.json({ error: structural.reason, orphans: structural.orphans }, 400);
  }

  // The xtina board is scripted end to end, so there is nothing to cheat — and one of its words
  // ("YOURE") is deliberately not in Collins/SOWPODS. Skipping the lookup here is what lets it
  // through; structural validation above still runs in full. An earlier design added YOURE to an
  // official word set instead, which was wrong: official sets are world-readable via
  // official_word_sets, so it would have appeared in the partner's Dictionary journal as a fake
  // language.
  if ((await roomMode(admin, roomId)) !== 'xtina') {
    const { data: invalidWords, error: dictError } = await admin.rpc('find_invalid_words', {
      p_room_id: roomId,
      p_words: structural.words,
    });
    if (dictError) return c.json({ error: dictError.message }, statusForRpcError(dictError.message));

    if (invalidWords && invalidWords.length > 0) {
      await admin.rpc('append_room_event', {
        p_room_id: roomId,
        p_type: 'plantains_rejected',
        p_payload: { actor: profileId, reason: 'INVALID_WORDS', invalidWords },
      });
      return c.json({ error: 'INVALID_WORDS', invalidWords }, 400);
    }
  }

  const { data, error } = await admin.rpc('finish_game', {
    p_room_id: roomId,
    p_winner: profileId,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));

  await admin.rpc('persist_grid', { p_room_id: roomId, p_profile: profileId, p_grid: body.grid });

  // Phase 1: roll the server-authoritative half of the game (peels, dumps, wins, streaks,
  // achievements) straight into profile_stats while room_players/room_events still exist.
  // Nothing per-game is stored — see migration 20260728000006. A rollup failure must not fail
  // the win, and game_over still fires either way so nobody is stranded on the game screen.
  try {
    const { error: rollupError } = await admin.rpc('archive_game', {
      p_room_id: roomId,
      p_winner: profileId,
    });
    if (rollupError) console.error('stat rollup failed', rollupError.message);
  } catch (err) {
    console.error('stat rollup threw', (err as Error).message);
  }

  await admin.rpc('append_room_event', {
    p_room_id: roomId,
    p_type: 'game_over',
    p_payload: { winner: profileId },
  });

  return c.json(data as object);
});

// --- Dictionary management ---------------------------------------------------

// Custom word sets: reads of "my sets" go directly from the client via RLS
// (see apps/web/src/lib/dictionaries.ts); only writes go through the Worker.
app.post('/dictionaries/sets', async (c) => {
  const profileId = c.get('profileId');
  const body = await c.req.json<{ name: string; words: string[] }>();
  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('create_custom_word_set', {
    p_owner: profileId,
    p_name: body.name,
    p_words: Array.isArray(body.words) ? body.words : [],
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

app.patch('/dictionaries/sets/:setId', async (c) => {
  const profileId = c.get('profileId');
  const setId = c.req.param('setId');
  const body = await c.req.json<{ name: string; words: string[] }>();
  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('update_custom_word_set', {
    p_owner: profileId,
    p_set_id: setId,
    p_name: body.name,
    p_words: Array.isArray(body.words) ? body.words : [],
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

app.delete('/dictionaries/sets/:setId', async (c) => {
  const profileId = c.get('profileId');
  const setId = c.req.param('setId');
  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('delete_custom_word_set', {
    p_owner: profileId,
    p_set_id: setId,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

// Dictionary presets: a named snapshot of a DictionaryConfig, reusable across rooms.
app.post('/dictionaries/presets', async (c) => {
  const profileId = c.get('profileId');
  const body = await c.req.json<{ name: string; config: DictionaryConfig }>();
  const admin = createAdminClient(c.env);

  const selectable = await fetchSelectableCustomSetIds(admin, profileId);
  const validity = validateDictionaryConfig(body.config, selectable);
  if (!validity.valid) return c.json({ error: validity.reason }, statusForRpcError(validity.reason));

  const { data, error } = await admin.rpc('save_dictionary_preset', {
    p_owner: profileId,
    p_name: body.name,
    p_config: body.config,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

app.delete('/dictionaries/presets/:presetId', async (c) => {
  const profileId = c.get('profileId');
  const presetId = c.req.param('presetId');
  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('delete_dictionary_preset', {
    p_owner: profileId,
    p_preset_id: presetId,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

// Room-owner control: set the active DictionaryConfig for a room pre-Split.
app.patch('/rooms/:roomId/dictionary', async (c) => {
  const profileId = c.get('profileId');
  const roomId = c.req.param('roomId');
  const body = await c.req.json<{ config: DictionaryConfig }>();
  const admin = createAdminClient(c.env);

  const selectable = await fetchSelectableCustomSetIds(admin, profileId);
  const validity = validateDictionaryConfig(body.config, selectable);
  if (!validity.valid) return c.json({ error: validity.reason }, statusForRpcError(validity.reason));

  const { data, error } = await admin.rpc('set_dictionary_config', {
    p_room_id: roomId,
    p_host: profileId,
    p_config: body.config,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

// Resolves {id, name} for the custom sets active in a room's config — a non-host can
// read the config's raw customSetIds via rooms_public, but RLS correctly hides other
// users' custom_word_sets rows, so this service-role-backed lookup fills in names.
app.get('/rooms/:roomId/dictionary/set-names', async (c) => {
  const roomId = c.req.param('roomId');
  const admin = createAdminClient(c.env);
  try {
    const sets = await resolveCustomSetNames(admin, roomId);
    return c.json({ sets });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 404);
  }
});

// --- Profile / account -------------------------------------------------------
// Reads of a profile / stats / achievements / match history go DIRECT via RLS from the
// client (apps/web/src/lib/profile.ts); only writes + the export/delete flows go here.

// Update display name and/or avatar. Either field optional (null = leave unchanged).
app.patch('/profile', async (c) => {
  const profileId = c.get('profileId');
  const body = await c.req.json<{ displayName?: string; avatarConfig?: AvatarConfig }>();

  if (body.displayName !== undefined) {
    const nameCheck = validateDisplayName(body.displayName);
    if (!nameCheck.valid) return c.json({ error: nameCheck.reason }, statusForRpcError(nameCheck.reason));
  }
  if (body.avatarConfig !== undefined) {
    const avatarCheck = validateAvatarConfig(body.avatarConfig);
    if (!avatarCheck.valid) return c.json({ error: avatarCheck.reason }, statusForRpcError(avatarCheck.reason));
  }

  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('update_profile', {
    p_profile: profileId,
    p_display_name: body.displayName ?? null,
    p_avatar_config: body.avatarConfig ?? null,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

// Full data export (client downloads it as JSON).
app.get('/profile/export', async (c) => {
  const profileId = c.get('profileId');
  const admin = createAdminClient(c.env);
  const data = await assembleExport(admin, profileId);
  return c.json(data);
});

// Permanent account deletion. Clear ephemeral-room references first (they'd otherwise
// block the cascade), then delete the auth user — which cascades to profiles and
// everything FK'd to it (stats, achievements, game_players, custom sets, presets).
app.delete('/profile', async (c) => {
  const profileId = c.get('profileId');
  const admin = createAdminClient(c.env);
  const { error: cleanupError } = await admin.rpc('prepare_account_deletion', { p_profile: profileId });
  if (cleanupError) return c.json({ error: cleanupError.message }, 400);
  const { error } = await admin.auth.admin.deleteUser(profileId);
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

// Toggle "xtina mode" availability for this profile.
app.post('/profile/xtina', async (c) => {
  const profileId = c.get('profileId');
  const body = await c.req.json<{ enabled: boolean }>();
  const admin = createAdminClient(c.env);
  const { data, error } = await admin.rpc('set_xtina_enabled', {
    p_profile: profileId,
    p_on: Boolean(body.enabled),
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

// Client end-of-game summary (Phase 2): the words a player made and their move stats, which
// only the client knows. Rolled straight into profile_stats — keyed by ROOM, since nothing
// per-game is stored. Idempotent server-side via room_players.summary_applied.
app.post('/rooms/:roomId/summary', async (c) => {
  const profileId = c.get('profileId');
  const roomId = c.req.param('roomId');
  const body = await c.req.json<GameSummary>();

  const check = validateGameSummary(body);
  if (!check.valid) return c.json({ error: 'INVALID_SUMMARY', reason: check.reason }, 400);

  const admin = createAdminClient(c.env);

  // An xtina game is not a real game: it must not touch lifetime stats, the daily streak, or
  // achievements. archive_game already early-returns for the server-side half; this is the
  // client-submitted half.
  if ((await roomMode(admin, roomId)) === 'xtina') {
    return c.json({ ok: true, longestWord: null, rarestWord: null, wordCount: 0 });
  }

  const { data, error } = await admin.rpc('submit_game_summary', {
    p_room_id: roomId,
    p_profile: profileId,
    p_summary: body,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));
  return c.json(data);
});

export default app;
