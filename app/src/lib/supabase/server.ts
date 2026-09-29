/**
 * Phase G.1 - the server-side Supabase client (route handlers, server components).
 *
 * Scoped to the SIGNED-IN USER's own session cookie - never the service role key. Every read
 * or write made with this client goes through Row Level Security exactly as a person's own
 * browser session already does; this is deliberately NOT a service-role/RLS-bypassing client,
 * so the Orchestrator's real-time permission checks and the database's own RLS policies stay
 * the only source of truth for what an API route is allowed to do on someone's behalf.
 */

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Called from a Server Component that can't set cookies - middleware refreshes
            // the session instead, so this is safe to ignore.
          }
        },
      },
    },
  );
}
