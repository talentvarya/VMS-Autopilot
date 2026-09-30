/**
 * Phase G.19 - starts the real Google Search Console OAuth connection. This route never logs
 * anyone in itself: it only builds Google's own authorize URL and redirects the browser to it.
 * Whoever clicks "Connect Search Console" signs in and consents on accounts.google.com's own
 * page - this app never sees that password.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';
import { buildAuthorizeUrl, isSearchConsoleIntegrationLive } from '@/lib/integrations/search-console';

export const OAUTH_COOKIE_NAME = 'search_console_oauth_state';

function randomState(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
}

export async function GET(request: Request) {
  if (!isSearchConsoleIntegrationLive()) {
    return NextResponse.json({ error: 'Search Console connections are not enabled in this environment' }, { status: 403 });
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const { searchParams, origin } = new URL(request.url);
  const workspaceId = searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });

  const resolved = await resolveWorkspaceRole(supabase, user.id, workspaceId);
  if (!resolved) return NextResponse.json({ error: 'you do not have access to that client' }, { status: 403 });
  if (resolved.role !== 'admin') {
    return NextResponse.json({ error: "only an Admin can connect a client's Search Console" }, { status: 403 });
  }

  if (!process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID) {
    return NextResponse.json(
      {
        error:
          'Search Console is not set up yet on this deployment - GOOGLE_SEARCH_CONSOLE_CLIENT_ID is missing. Register an OAuth client in Google Cloud Console and add GOOGLE_SEARCH_CONSOLE_CLIENT_ID/GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET to Vercel first.',
      },
      { status: 503 },
    );
  }

  const state = randomState();
  const redirectUri = `${origin}/api/integrations/search-console/callback`;
  const authorizeUrl = buildAuthorizeUrl({ redirectUri, state });

  const jar = await cookies();
  jar.set(OAUTH_COOKIE_NAME, JSON.stringify({ state, workspaceId, redirectUri }), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/api/integrations/search-console',
  });

  return NextResponse.redirect(authorizeUrl);
}
