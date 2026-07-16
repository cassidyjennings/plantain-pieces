import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { validateStructure, validateDictionaryConfig, type GridState, type DictionaryConfig } from '@plantain/shared';
import type { Env } from './env.js';
import { createAdminClient } from './supabase.js';
import { requireAuth } from './auth.js';
import { statusForRpcError } from './rpcError.js';
import { fetchRack } from './gridValidation.js';
import { fetchOwnedCustomSetIds, resolveCustomSetNames } from './dictionaries.js';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());
app.use('/rooms/*', requireAuth);
app.use('/dictionaries/*', requireAuth);

app.get('/', (c) => c.json({ ok: true, service: 'plantain-pieces-api' }));

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

  const { data, error } = await admin.rpc('finish_game', {
    p_room_id: roomId,
    p_winner: profileId,
  });
  if (error) return c.json({ error: error.message }, statusForRpcError(error.message));

  await admin.rpc('persist_grid', { p_room_id: roomId, p_profile: profileId, p_grid: body.grid });
  return c.json(data);
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

  const owned = await fetchOwnedCustomSetIds(admin, profileId);
  const validity = validateDictionaryConfig(body.config, owned);
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

  const owned = await fetchOwnedCustomSetIds(admin, profileId);
  const validity = validateDictionaryConfig(body.config, owned);
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

export default app;
