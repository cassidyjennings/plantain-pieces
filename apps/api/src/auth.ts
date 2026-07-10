import type { MiddlewareHandler } from 'hono';
import { createAnonClient } from './supabase.js';
import type { Env } from './env.js';

declare module 'hono' {
  interface ContextVariableMap {
    profileId: string;
  }
}

/**
 * Requires a valid Supabase-issued Bearer token (guest or OAuth-upgraded).
 * Verifies by calling Supabase Auth directly rather than checking the JWT
 * ourselves, so revoked/expired tokens are rejected without duplicating
 * Supabase's signing-key logic in the Worker.
 */
export const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return c.json({ error: 'UNAUTHORIZED' }, 401);

  const supabase = createAnonClient(c.env);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return c.json({ error: 'UNAUTHORIZED' }, 401);

  c.set('profileId', data.user.id);
  await next();
};
