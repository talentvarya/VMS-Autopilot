/**
 * Phase G.11 - real Buffer OAuth 2.0 (Authorization Code + PKCE) integration. Read-only: lets a
 * real client's Buffer account be connected so their real channels and real post-metrics can
 * be shown in the "Connected Accounts" page. Nothing here ever creates, schedules or publishes
 * a post - that stays a separate, future decision, and the sandbox Social Publishing page is
 * completely untouched by this file.
 *
 * The actual login/consent always happens on Buffer's own pages (auth.buffer.com), in the
 * signed-in person's own browser - this file only builds the redirect URL and exchanges the
 * code Buffer sends back. It never sees, logs or returns a Buffer password, and the
 * client_secret is read from an env var by name only, exactly like every other provider key in
 * this app (OpenAI, Gemini, Anthropic).
 *
 * Endpoints and query shapes below were read from developers.buffer.com on 2026-09-30
 * (guides/authentication.html, guides/getting-started.html, examples/get-channels.html,
 * examples/get-organizations.html, examples/aggregate-post-metrics.html). Nothing here has been
 * exercised against a real Buffer account yet - Buffer's own error message is always surfaced
 * back (never swallowed), so a wrong field name shows up as a clear failure the first time
 * someone actually connects, rather than as a silent no-op.
 */

import { randomBytes, createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { liveFeaturesConceivable } from '@/lib/config/environment';

export const LIVE_BUFFER_INTEGRATION_ENABLED = true as const;

export function isBufferIntegrationLive(overrides?: { liveEnabled?: boolean; env?: NodeJS.ProcessEnv }): boolean {
  const liveEnabled = overrides?.liveEnabled ?? LIVE_BUFFER_INTEGRATION_ENABLED;
  return liveEnabled && liveFeaturesConceivable(overrides?.env);
}

const AUTHORIZE_URL = 'https://auth.buffer.com/auth';
const TOKEN_URL = 'https://auth.buffer.com/token';
const GRAPHQL_URL = 'https://api.buffer.com';
// Read-only on purpose: no posts:write, so this integration cannot publish anything even if
// asked to - a real "post from here" feature would need its own separate scope and review.
const SCOPES = 'posts:read ideas:read account:read offline_access';

/** Every social platform Buffer supports connecting a channel for (2026-09-30). */
export const BUFFER_SERVICE_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  pinterest: 'Pinterest',
  twitter: 'X (Twitter)',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  mastodon: 'Mastodon',
  threads: 'Threads',
  bluesky: 'Bluesky',
  whatsapp: 'WhatsApp',
  substack: 'Substack',
};

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateCodeVerifier(): string {
  return base64url(randomBytes(48));
}

export function codeChallengeFromVerifier(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function generateState(): string {
  return base64url(randomBytes(24));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function buildAuthorizeUrl(params: { redirectUri: string; state: string; codeChallenge: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', requireEnv('BUFFER_CLIENT_ID'));
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface BufferTokens {
  accessToken: string;
  /** Buffer does not always return a refresh token (observed live 2026-09-30) - when absent, the
   *  connection simply expires after expiresAt and the person reconnects. */
  refreshToken: string | null;
  expiresAt: string;
}

async function postForm(body: Record<string, string>): Promise<BufferTokens> {
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
    throw new Error(json?.error_description || json?.error || 'Buffer did not return an access token');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString(),
  };
}

export async function exchangeCodeForTokens(params: { code: string; redirectUri: string; codeVerifier: string }): Promise<BufferTokens> {
  return postForm({
    client_id: requireEnv('BUFFER_CLIENT_ID'),
    client_secret: requireEnv('BUFFER_CLIENT_SECRET'),
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
}

/** Refresh tokens are single-use (Buffer's own docs) - callers must persist the NEW pair this returns, every time. */
export async function refreshTokens(refreshToken: string): Promise<BufferTokens> {
  return postForm({
    client_id: requireEnv('BUFFER_CLIENT_ID'),
    client_secret: requireEnv('BUFFER_CLIENT_SECRET'),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

async function graphql<T>(accessToken: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query, variables }),
  });
  const json: { data?: T; errors?: { message: string }[] } | null = await res.json().catch(() => null);
  if (!res.ok || json?.errors?.length) {
    throw new Error(json?.errors?.[0]?.message || 'Buffer API request failed');
  }
  if (!json?.data) throw new Error('Buffer API returned no data');
  return json.data;
}

export async function fetchOrganizations(accessToken: string): Promise<{ id: string; name: string; ownerEmail: string }[]> {
  const data = await graphql<{ account: { organizations: { id: string; name: string; ownerEmail: string }[] } }>(
    accessToken,
    `query { account { organizations { id name ownerEmail } } }`,
  );
  return data.account.organizations;
}

export interface BufferChannel {
  id: string;
  name: string;
  displayName: string;
  service: string;
  avatar: string | null;
  isQueuePaused: boolean;
}

export async function fetchChannels(accessToken: string, organizationId: string): Promise<BufferChannel[]> {
  const data = await graphql<{ channels: BufferChannel[] }>(
    accessToken,
    `query($organizationId: OrganizationId!) { channels(input: { organizationId: $organizationId }) { id name displayName service avatar isQueuePaused } }`,
    { organizationId },
  );
  return data.channels;
}

export interface BufferMetric { type: string; value: number; unit: string }

interface BufferConnectionRow {
  buffer_organization_id: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string;
}

/**
 * Reads the stored connection for a workspace via the service-role client (the only client
 * allowed to - see the migration) and refreshes the access token first if it is expired or
 * about to expire. Refresh tokens are single-use, so a refreshed pair is written straight back
 * before the caller ever gets a chance to use the (now-invalid) old refresh token. When Buffer
 * never gave this connection a refresh token, an expired access token can't be renewed - the
 * caller gets null back, same as "not connected", and the person reconnects from the UI.
 */
export async function getValidBufferAccessToken(
  service: SupabaseClient,
  workspaceId: string,
): Promise<{ accessToken: string; organizationId: string } | null> {
  const { data } = await service
    .from('buffer_connections')
    .select('buffer_organization_id, access_token, refresh_token, token_expires_at')
    .eq('workspace_id', workspaceId)
    .maybeSingle<BufferConnectionRow>();
  if (!data) return null;

  const expiresInMs = new Date(data.token_expires_at).getTime() - Date.now();
  if (expiresInMs > 60_000) {
    return { accessToken: data.access_token, organizationId: data.buffer_organization_id };
  }
  if (!data.refresh_token) return null;

  const refreshed = await refreshTokens(data.refresh_token);
  await service
    .from('buffer_connections')
    .update({ access_token: refreshed.accessToken, refresh_token: refreshed.refreshToken, token_expires_at: refreshed.expiresAt })
    .eq('workspace_id', workspaceId);
  return { accessToken: refreshed.accessToken, organizationId: data.buffer_organization_id };
}

export async function fetchAggregatedMetrics(
  accessToken: string,
  organizationId: string,
  channelIds: string[],
  startDateTime: string,
  endDateTime: string,
): Promise<{ metrics: BufferMetric[]; metricsUpdatedAt: string | null }> {
  const data = await graphql<{ aggregatedPostMetrics: { metrics: BufferMetric[]; metricsUpdatedAt: string | null } }>(
    accessToken,
    `query($organizationId: OrganizationId!, $channelIds: [ID!]!, $startDateTime: DateTime!, $endDateTime: DateTime!) {
      aggregatedPostMetrics(input: { organizationId: $organizationId, channelIds: $channelIds, startDateTime: $startDateTime, endDateTime: $endDateTime }) {
        metrics { type value unit }
        metricsUpdatedAt
      }
    }`,
    { organizationId, channelIds, startDateTime, endDateTime },
  );
  return data.aggregatedPostMetrics;
}
