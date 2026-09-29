/**
 * Phase G.6 - the service-role client. Bypasses Row Level Security entirely, so it must NEVER
 * be imported by anything that can run in the browser (no 'use client' file, no component) -
 * only from a Next.js Route Handler (app/api/**\/route.ts), which always runs server-side.
 *
 * Used ONLY for the narrow set of writes the database itself restricts to service_role - see
 * the "Privileges" section of supabase/migrations/20260929000600_staging_safety_foundation.sql
 * (ai_usage_log has no insert grant for `authenticated` on purpose: a person's own browser
 * session must never be able to write its own AI-cost record, or the usage cap it enforces
 * would be trivially bypassable). Every other read/write in this app goes through
 * src/lib/supabase/server.ts (the signed-in user's own session, RLS-scoped) instead - this
 * file is deliberately the exception, not the default.
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js';

export function createServiceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
