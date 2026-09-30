/**
 * Phase G.13 - a basic, zero-dependency rate limiter for API routes. Fixed window, per client
 * IP, held in memory inside the middleware's own process.
 *
 * Honest limitation: this is per-instance, not distributed. Vercel can route two requests from
 * the same IP to two different warm instances, each with its own counter, so the real effective
 * limit under heavy, spread-out traffic is looser than the configured number. A real
 * distributed limiter needs shared storage (Redis/Vercel KV) - a separate, later decision if
 * this app's traffic ever outgrows what an in-memory limiter can reasonably catch. For this
 * app's actual scale (an agency and its clients, not public internet traffic), this still stops
 * the common case - one client hammering a route, a runaway loop in a script or a browser tab -
 * without adding a new paid service or a new signup.
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 60;
const MAX_TRACKED_KEYS = 5000;

const hits = new Map<string, { count: number; resetAt: number }>();

function sweepExpired(now: number) {
  if (hits.size < MAX_TRACKED_KEYS) return;
  for (const [key, entry] of hits) {
    if (now > entry.resetAt) hits.delete(key);
  }
}

/** Returns true if this key has exceeded the window's request budget. */
export function isRateLimited(key: string, now = Date.now()): boolean {
  sweepExpired(now);
  const entry = hits.get(key);
  if (!entry || now > entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_REQUESTS_PER_WINDOW;
}

export function clientIp(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}
