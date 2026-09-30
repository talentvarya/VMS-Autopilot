/**
 * Phase G.19 - real Google Search Console OAuth 2.0 integration. Read-only: lets a real client's
 * Search Console data (site verification status, search clicks/impressions, top queries) be
 * shown in the app. Nothing here can change a site's Search Console settings, submit a sitemap,
 * or request indexing - the scope is webmasters.readonly.
 *
 * The actual login/consent always happens on Google's own page (accounts.google.com), in the
 * signed-in person's own browser - this file only builds the redirect URL and exchanges the
 * code Google sends back. It never sees, logs or returns a Google password, and the client
 * secret is read from an env var by name only, exactly like every other provider key in this app.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { liveFeaturesConceivable } from '@/lib/config/environment';

export const LIVE_SEARCH_CONSOLE_INTEGRATION_ENABLED = true as const;

export function isSearchConsoleIntegrationLive(overrides?: { liveEnabled?: boolean; env?: NodeJS.ProcessEnv }): boolean {
  const liveEnabled = overrides?.liveEnabled ?? LIVE_SEARCH_CONSOLE_INTEGRATION_ENABLED;
  return liveEnabled && liveFeaturesConceivable(overrides?.env);
}

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://searchconsole.googleapis.com/webmasters/v3';
// Read-only on purpose: this integration can never change a site's Search Console settings.
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function buildAuthorizeUrl(params: { redirectUri: string; state: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', requireEnv('GOOGLE_SEARCH_CONSOLE_CLIENT_ID'));
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', params.state);
  // offline -> a refresh token; consent (forced) -> that refresh token is handed back even if
  // this Google account already granted this app access before.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export interface GoogleTokens {
  accessToken: string;
  /** Google only returns this on the FIRST consent for a given account+app, or when forced with
   *  prompt=consent (always requested here) - still nullable in case a future response omits it,
   *  same lesson learned live from the Buffer integration. */
  refreshToken: string | null;
  expiresAt: string;
}

async function postForm(body: Record<string, string>): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const rawText = await res.text();
  let json: { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string } | null = null;
  try {
    json = JSON.parse(rawText);
  } catch {
    json = null;
  }
  if (!res.ok || !json?.access_token) {
    throw new Error(json?.error_description || json?.error || 'Google did not return an access token');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString(),
  };
}

export async function exchangeCodeForTokens(params: { code: string; redirectUri: string }): Promise<GoogleTokens> {
  return postForm({
    client_id: requireEnv('GOOGLE_SEARCH_CONSOLE_CLIENT_ID'),
    client_secret: requireEnv('GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET'),
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
  });
}

export async function refreshTokens(refreshToken: string): Promise<GoogleTokens> {
  return postForm({
    client_id: requireEnv('GOOGLE_SEARCH_CONSOLE_CLIENT_ID'),
    client_secret: requireEnv('GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET'),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

async function apiGet<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message || 'Google Search Console API request failed');
  return json as T;
}

async function apiPost<T>(accessToken: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message || 'Google Search Console API request failed');
  return json as T;
}

export interface SearchConsoleSite { siteUrl: string; permissionLevel: string }

/** Every Search Console property this Google account has ANY access to - unverified sites show up too, with permissionLevel 'siteUnverifiedUser'. */
export async function fetchVerifiedSites(accessToken: string): Promise<SearchConsoleSite[]> {
  const data = await apiGet<{ siteEntry?: SearchConsoleSite[] }>(accessToken, '/sites');
  return data.siteEntry ?? [];
}

/** Matches a saved client website against the Search Console sites list - handles both URL-prefix ("https://example.com/") and domain ("sc-domain:example.com") property formats. */
export function findMatchingSite(sites: SearchConsoleSite[], websiteOrigin: string): SearchConsoleSite | null {
  const host = new URL(websiteOrigin).hostname.replace(/^www\./, '');
  return (
    sites.find((s) => s.siteUrl === `sc-domain:${host}`) ??
    sites.find((s) => {
      try {
        return new URL(s.siteUrl).hostname.replace(/^www\./, '') === host;
      } catch {
        return false;
      }
    }) ??
    null
  );
}

export interface SearchAnalyticsTotals { clicks: number; impressions: number; ctr: number; position: number }
export interface SearchAnalyticsQueryRow { query: string; clicks: number; impressions: number; ctr: number; position: number }

interface SearchAnalyticsRow { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }

/** Last 28 days is the window Search Console itself defaults to - its own data typically lags 2-3 days behind today. */
export async function fetchSearchPerformance(
  accessToken: string,
  siteUrl: string,
): Promise<{ totals: SearchAnalyticsTotals; topQueries: SearchAnalyticsQueryRow[] }> {
  const end = new Date();
  end.setDate(end.getDate() - 3);
  const start = new Date(end);
  start.setDate(start.getDate() - 28);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const encodedSite = encodeURIComponent(siteUrl);
  const [totalsRes, queriesRes] = await Promise.all([
    apiPost<{ rows?: SearchAnalyticsRow[] }>(accessToken, `/sites/${encodedSite}/searchAnalytics/query`, {
      startDate: iso(start),
      endDate: iso(end),
    }),
    apiPost<{ rows?: SearchAnalyticsRow[] }>(accessToken, `/sites/${encodedSite}/searchAnalytics/query`, {
      startDate: iso(start),
      endDate: iso(end),
      dimensions: ['query'],
      rowLimit: 10,
    }),
  ]);

  const totalsRow = totalsRes.rows?.[0];
  const totals: SearchAnalyticsTotals = totalsRow
    ? { clicks: totalsRow.clicks, impressions: totalsRow.impressions, ctr: totalsRow.ctr, position: totalsRow.position }
    : { clicks: 0, impressions: 0, ctr: 0, position: 0 };

  const topQueries: SearchAnalyticsQueryRow[] = (queriesRes.rows ?? []).map((r) => ({
    query: r.keys?.[0] ?? '(unknown)',
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));

  return { totals, topQueries };
}

interface SearchConsoleConnectionRow {
  site_url: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string;
}

/**
 * Reads the stored connection for a workspace via the service-role client and refreshes the
 * access token first if it is expired or about to expire. When there is no refresh token, an
 * expired access token can't be renewed - the caller gets null back, same as "not connected",
 * and the person reconnects from the UI.
 */
export async function getValidSearchConsoleAccessToken(
  service: SupabaseClient,
  workspaceId: string,
): Promise<{ accessToken: string; siteUrl: string } | null> {
  const { data } = await service
    .from('search_console_connections')
    .select('site_url, access_token, refresh_token, token_expires_at')
    .eq('workspace_id', workspaceId)
    .maybeSingle<SearchConsoleConnectionRow>();
  if (!data) return null;

  const expiresInMs = new Date(data.token_expires_at).getTime() - Date.now();
  if (expiresInMs > 60_000) {
    return { accessToken: data.access_token, siteUrl: data.site_url };
  }
  if (!data.refresh_token) return null;

  const refreshed = await refreshTokens(data.refresh_token);
  await service
    .from('search_console_connections')
    .update({
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken ?? data.refresh_token,
      token_expires_at: refreshed.expiresAt,
    })
    .eq('workspace_id', workspaceId);
  return { accessToken: refreshed.accessToken, siteUrl: data.site_url };
}
