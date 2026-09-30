/**
 * Never sends Postgres/PostgREST's own error text to the browser - it can quote real table,
 * column or constraint names (e.g. `duplicate key value violates unique constraint
 * "workspaces_slug_key"`, or an RLS policy's own name), which nobody outside this app's code
 * should see. Logs the real error server-side (visible in Vercel's function logs, where a
 * developer can actually act on it) and returns one of a small set of generic, safe messages
 * instead, chosen from the error's own Postgres/PostgREST code so the message stays useful
 * without repeating any schema detail.
 */

import { NextResponse } from 'next/server';

interface DbLikeError {
  code?: string | null;
  message: string;
}

const SAFE_MESSAGES: Record<string, string> = {
  '23505': 'That already exists.',
  '23503': 'That reference no longer exists.',
  '23514': 'That value is not allowed.',
  '22001': 'That value is too long.',
  '42501': 'You do not have permission to do that.',
  PGRST301: 'You do not have permission to do that.',
  PGRST116: 'That was not found.',
};

export function dbErrorResponse(error: DbLikeError, status = 400): NextResponse {
  console.error('[db error]', error.code ?? '(no code)', error.message);
  // P0001 is a plain `raise exception` from this app's own trigger functions (e.g.
  // trg_approval_before, trg_ai_usage_cap_before) - hand-written, human-readable text meant
  // for the end user, never a raw schema detail, so it is safe to pass through as-is.
  if (error.code === 'P0001') return NextResponse.json({ error: error.message }, { status });
  const message = (error.code && SAFE_MESSAGES[error.code]) || 'Something went wrong. Please try again.';
  return NextResponse.json({ error: message }, { status });
}
