/** Display-name rules shared by the client (instant feedback) and the Worker/RPC
 * (authoritative). Names are NOT globally unique — this is a casual game, so many
 * players may share a name; we only bound length + allowed characters. */

export const DISPLAY_NAME_MIN = 1;
export const DISPLAY_NAME_MAX = 20;

/** Control characters are the only thing disallowed — everything else (letters of any
 * script, digits, punctuation, symbols, emoji) is allowed in a display name. */
export const DISPLAY_NAME_CONTROL_CHARS = /[\p{Cc}\p{Cf}]/u;

export type DisplayNameValidity =
  | { valid: true }
  | { valid: false; reason: 'EMPTY' | 'TOO_LONG' | 'INVALID_CHARS' };

/** Validates a candidate display name. Names may contain special characters; only the
 * length is bounded and control characters are rejected. Expects the caller to have
 * trimmed it, but is defensive about surrounding whitespace so a raw value can't slip through. */
export function validateDisplayName(raw: string): DisplayNameValidity {
  const name = raw.trim();
  if (name.length < DISPLAY_NAME_MIN) return { valid: false, reason: 'EMPTY' };
  if (name.length > DISPLAY_NAME_MAX) return { valid: false, reason: 'TOO_LONG' };
  if (DISPLAY_NAME_CONTROL_CHARS.test(name)) return { valid: false, reason: 'INVALID_CHARS' };
  return { valid: true };
}
