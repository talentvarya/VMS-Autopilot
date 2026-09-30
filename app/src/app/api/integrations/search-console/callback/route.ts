/**
 * Phase G.19 - the callback Google redirects back to once the person has signed in and
 * consented. Exchanges the one-time code for tokens (server-side, using
 * GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET - never logged, returned, or exposed to the browser),
 * matches the connected Google account's Search Console properties against this client's saved
 * website, and stores the connection with the service-role client (search_console_connections
 * has no grant for `authenticated` at all - see the migration).
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { exchangeCodeForTokens, fetchVerifiedSites, findMatchingSite } from '@/lib/integrations/search-console';
import { OAUTH_COOKIE_NAME } from '../authorize/route';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const jar = await cookies();
  const raw = jar.get(OAUTH_COOKIE_NAME)?.value;
  jar.delete(OAUTH_COOKIE_NAME);

  const redirectHome = (status: 'connected' | 'error', detail: string) =>
    NextResponse.redirect(`${origin}/?searchConsole=${status}&searchConsoleMessage=${encodeURIComponent(detail)}`);

  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const providerError = searchParams.get('error_description') || searchParams.get('error');
  if (providerError) return redirectHome('error', providerError);
  if (!code || !state) return redirectHome('error', 'Google did not send back a code');

  let saved: { state: string; workspaceId: string; redirectUri: string };
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
    const tokens = await exchangeCodeForTokens({ code, redirectUri: saved.redirectUri });
    const sites = await fetchVerifiedSites(tokens.accessToken);

    const { data: workspace } = await supabase.from('workspaces').select('website_url').eq('id', saved.workspaceId).maybeSingle();
    const matched = workspace?.website_url ? findMatchingSite(sites, workspace.website_url) : null;
    // Fall back to whichever property the account has, so the connection still saves even when
    // the saved website URL doesn't exactly match a Search Console property - the status page
    // then shows the actual matched site so an Admin can see and fix a mismatch.
    const site = matched ?? sites[0];
    if (!site) throw new Error('That Google account has no Search Console properties to connect');

    const service = createServiceClient();
    const { error } = await service.from('search_console_connections').upsert(
      {
        workspace_id: saved.workspaceId,
        site_url: site.siteUrl,
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
      throw new Error('Could not save the Search Console connection. Please try again.');
    }

    return redirectHome('connected', site.siteUrl);
  } catch (err) {
    return redirectHome('error', err instanceof Error ? err.message : 'Could not finish connecting to Search Console');
  }
}
