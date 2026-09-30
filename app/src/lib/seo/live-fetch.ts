/**
 * Phase G.16 - the ONE file in lib/seo allowed to touch the network (see the folder-wide scan
 * in tests/seo/safety.test.ts). Fetches a real website's homepage, robots.txt, sitemap.xml and
 * llms.txt into a SiteSnapshot for the SAME audit engine that already reads sample-site
 * snapshots (engine.ts never fetches anything itself either way).
 *
 * assertSafeUrl() (safe-url.ts) is necessary but explicitly NOT sufficient by itself - its own
 * doc comment says why: a hostile name can still resolve to a private address (an attacker
 * pointing their own domain at 127.0.0.1, or "DNS rebinding" - answering safely when checked and
 * unsafely a moment later when connected to). So every request here:
 *   1. Validates the URL's shape (assertSafeUrl).
 *   2. Resolves its hostname with Node's own resolver and rejects any private/reserved result.
 *   3. Connects to that EXACT resolved address (an undici Agent pinned via a custom `lookup`
 *      that ignores whatever hostname it's asked to resolve and always returns the address
 *      already checked in step 2) - so nothing can change the answer between check and connect.
 *   4. Re-runs all three steps on every redirect hop, including cross-host ones - a redirect to
 *      an internal address is refused exactly like a direct link to one would be.
 * A capped read (MAX_BODY_BYTES) and a request timeout stop a slow or huge response from tying
 * up a function indefinitely.
 */

import { promises as dns } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { assertSafeUrl, UnsafeUrlError } from './safe-url';
import type { SiteSnapshot } from './types';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'VMSAutopilotSEOBot/1.0 (+https://vms-autopilot.vercel.app) - read-only SEO/GEO audit, never posts or writes anything';

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('::ffff:')) return isPrivateIpv4(lower.slice(7));
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
  return false;
}

function isPrivateIp(address: string, family: number): boolean {
  return family === 6 ? isPrivateIpv6(address) : isPrivateIpv4(address);
}

async function resolvePinnedAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  let records: { address: string; family: number }[];
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError('the website name could not be resolved');
  }
  const safe = records.find((r) => !isPrivateIp(r.address, r.family));
  if (!safe) throw new UnsafeUrlError('the website name resolves only to a private or reserved address');
  return { address: safe.address, family: safe.family as 4 | 6 };
}

function pinnedAgent(address: string, family: 4 | 6): Agent {
  return new Agent({
    connect: {
      // Node's own lookup can be called two ways: lookup(hostname, callback) or
      // lookup(hostname, options, callback) - and when Happy Eyeballs asks for `{ all: true }`,
      // it expects back an array of { address, family }, not the plain (address, family) pair.
      // Always answering in the old 3-arg shape made the `all` caller read `address` as its
      // addresses array and fail with "Invalid IP address: undefined".
      lookup: ((_hostname, optsOrCallback, maybeCallback) => {
        const callback = typeof optsOrCallback === 'function' ? optsOrCallback : maybeCallback!;
        const wantsAll = typeof optsOrCallback === 'object' && optsOrCallback !== null && optsOrCallback.all === true;
        if (wantsAll) callback(null, [{ address, family }]);
        else callback(null, address, family);
      }) as LookupFunction,
    },
  });
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
}

async function safeFetch(rawUrl: string): Promise<RawResponse> {
  let current = assertSafeUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { address, family } = await resolvePinnedAddress(current.hostname);
    const agent = pinnedAgent(address, family);
    let res: Dispatcher.ResponseData | Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(current.href, {
        dispatcher: agent,
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/xml,text/plain' },
      });
    } finally {
      await agent.close().catch(() => {});
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new UnsafeUrlError('the website redirected without saying where to');
      const next = new URL(location, current);
      current = assertSafeUrl(next.href);
      continue;
    }

    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    if (reader) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    const headers: Record<string, string> = {};
    res.headers.forEach((value: string, key: string) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: res.status, headers, body, finalUrl: current.href };
  }
  throw new UnsafeUrlError('too many redirects');
}

/** string = fetched and exists, null = fetched and returned 404, undefined = could not be fetched at all. */
async function fetchAuxiliaryText(origin: string, path: string): Promise<string | null | undefined> {
  try {
    const res = await safeFetch(new URL(path, origin).href);
    if (res.status === 404) return null;
    if (res.status >= 200 && res.status < 300) return res.body.slice(0, 200_000);
    return undefined;
  } catch {
    return undefined;
  }
}

export async function fetchLiveSnapshot(origin: string): Promise<SiteSnapshot> {
  const base = assertSafeUrl(origin);
  const page = await safeFetch(base.href);
  if (page.status < 200 || page.status >= 400) {
    throw new Error(`the website returned status ${page.status} and could not be audited`);
  }

  const [robotsTxt, sitemapXml, llmsTxt] = await Promise.all([
    fetchAuxiliaryText(base.origin, '/robots.txt'),
    fetchAuxiliaryText(base.origin, '/sitemap.xml'),
    fetchAuxiliaryText(base.origin, '/llms.txt'),
  ]);

  return {
    url: page.finalUrl,
    status: page.status,
    headers: page.headers,
    html: page.body,
    robotsTxt,
    sitemapXml,
    llmsTxt,
    fetchedAt: new Date().toISOString(),
  };
}
