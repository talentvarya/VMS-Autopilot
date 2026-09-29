/**
 * Phase G.1 - the browser-side Supabase client. Reads only the two NEXT_PUBLIC_ values that
 * were always documented for exactly this purpose (.env.example, staging-env-spec.ts) -
 * nothing here reads or exposes SUPABASE_SERVICE_ROLE_KEY, which never belongs in the browser.
 */

import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
