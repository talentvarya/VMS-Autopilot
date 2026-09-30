/**
 * Phase G.11 - starts the real Buffer OAuth connection. This route never logs anyone in itself:
 * it only builds Buffer's own authorize URL and redirects the browser to it. Whoever clicks
 * "Connect Buffer" (an Admin, sitting with the client or holding their login) signs in and
 * consents on auth.buffer.com's own page - this app never sees that password.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';
import { buildAuthorizeUrl, codeChallengeFromVerifier, generateCodeVerifier, generateState, isBufferIntegrationLive } from '@/lib/integrations/buffer';

export const OAUTH_COOKIE_NAME = 'buffer_oauth_state';

export async function GET(request: Request) {
  if (!isBufferIntegrationLive()) {
    return NextResponse.json({ error: 'Buffer connections are not enabled in this environment' }, { status: 403 });
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
    return NextResponse.json({ error: "only an Admin can connect a client's Buffer account" }, { status: 403 });
  }

  if (!process.env.BUFFER_CLIENT_ID) {
    return NextResponse.json(
      { error: 'Buffer is not set up yet on this deployment - BUFFER_CLIENT_ID is missing. Register a Buffer Developer App and add BUFFER_CLIENT_ID/BUFFER_CLIENT_SECRET to Vercel first.' },
      { status: 503 },
    );
  }

  const codeVerifier = generateCodeVerifier();
  const state = generateState();
  const redirectUri = `${origin}/api/integrations/buffer/callback`;
  const authorizeUrl = buildAuthorizeUrl({ redirectUri, state, codeChallenge: codeChallengeFromVerifier(codeVerifier) });

  const jar = await cookies();
  jar.set(OAUTH_COOKIE_NAME, JSON.stringify({ state, codeVerifier, workspaceId, redirectUri }), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/api/integrations/buffer',
  });

  return NextResponse.redirect(authorizeUrl);
}
