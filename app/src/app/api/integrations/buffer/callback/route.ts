/**
 * Phase G.11 - the callback Buffer redirects back to once the person has signed in and
 * consented on Buffer's own page. Exchanges the one-time code for tokens (server-side, using
 * BUFFER_CLIENT_SECRET - never logged, returned, or exposed to the browser), fetches which
 * Buffer organization those tokens belong to, and stores the connection with the service-role
 * client (buffer_connections has no grant for `authenticated` at all - see the migration).
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { exchangeCodeForTokens, fetchOrganizations } from '@/lib/integrations/buffer';
import { OAUTH_COOKIE_NAME } from '../authorize/route';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const jar = await cookies();
  const raw = jar.get(OAUTH_COOKIE_NAME)?.value;
  jar.delete(OAUTH_COOKIE_NAME);

  const redirectHome = (status: 'connected' | 'error', detail: string) =>
    NextResponse.redirect(`${origin}/?buffer=${status}&bufferMessage=${encodeURIComponent(detail)}`);

  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const providerError = searchParams.get('error_description') || searchParams.get('error');
  if (providerError) return redirectHome('error', providerError);
  if (!code || !state) return redirectHome('error', 'Buffer did not send back a code');

  let saved: { state: string; codeVerifier: string; workspaceId: string; redirectUri: string };
  try {
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    return redirectHome('error', 'The connection attempt expired. Please try again.');
  }
  if (!saved || saved.state !== state) return redirectHome('error', 'The connection attempt expired. Please try again.');

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return redirectHome('error', 'You were signed out during the connection. Please sign in and try again.');

  try {
    const tokens = await exchangeCodeForTokens({ code, redirectUri: saved.redirectUri, codeVerifier: saved.codeVerifier });
    const organizations = await fetchOrganizations(tokens.accessToken);
    const organization = organizations[0];
    if (!organization) throw new Error('That Buffer account has no organizations to connect');

    const service = createServiceClient();
    const { error } = await service.from('buffer_connections').upsert(
      {
        workspace_id: saved.workspaceId,
        buffer_organization_id: organization.id,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_expires_at: tokens.expiresAt,
        connected_by: user.id,
        connected_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id' },
    );
    if (error) {
      console.error('[db error]', error.code ?? '(no code)', error.message);
      throw new Error('Could not save the Buffer connection. Please try again.');
    }

    return redirectHome('connected', organization.name);
  } catch (err) {
    return redirectHome('error', err instanceof Error ? err.message : 'Could not finish connecting to Buffer');
  }
}
