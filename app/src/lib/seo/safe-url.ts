/**
 * Guard for any address the audit system might one day fetch.
 *
 * Why it exists: an audit fetches a website on someone's behalf. If a user could point it at
 * "http://169.254.169.254/" (a cloud server's secret-key endpoint), "http://localhost:5432" or
 * an office printer, the audit would become a way to read the agency's INTERNAL network
 * (a "server-side request forgery" or SSRF attack). So only ordinary public website names on
 * ordinary web ports are accepted.
 *
 * Phase 2 never fetches anything (see sources.ts). This guard is built and tested now so it
 * is already in place, and reviewed, when live audits are approved.
 *
 * NOT enough by itself: a website name can resolve to a private address - either an attacker's
 * own name pointed at 127.0.0.1 (services like nip.io and localtest.me do this on purpose), or a
 * name that changes its answer between the check and the connection (DNS rebinding). The live
 * fetcher MUST therefore also resolve the name, reject private results, and connect to that exact
 * address. That is a hard requirement before live audits are approved; the fetcher does not
 * exist yet.
 */

export class UnsafeUrlError extends Error {
  constructor(public readonly reason: string) {
    super(`This address cannot be audited: ${reason}`);
    this.name = 'UnsafeUrlError';
  }
}

const MAX_LENGTH = 2048;
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
/** Names that only make sense inside a private network, or that can never be real public sites. */
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet', '.private', '.test', '.example', '.invalid'];
const PRIVATE_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);

export function assertSafeUrl(input: string): URL {
  if (typeof input !== 'string' || input.length === 0) throw new UnsafeUrlError('the address is empty');
  if (input.length > MAX_LENGTH) throw new UnsafeUrlError('the address is too long');
  if (/[\u0000-\u001f\u007f\s\\]/.test(input.trim())) throw new UnsafeUrlError('the address contains spaces or control characters');

  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UnsafeUrlError('it is not a valid web address');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UnsafeUrlError('only http and https addresses are allowed');
  if (url.username || url.password) throw new UnsafeUrlError('addresses with a username or password are not allowed');
  if (!ALLOWED_PORTS.has(url.port)) throw new UnsafeUrlError(`port ${url.port} is not allowed`);

  // Strip EVERY trailing dot ("localhost." and "localhost.." both mean localhost), then refuse
  // any name with an empty part ("a..b.com", ".x.com").
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host) throw new UnsafeUrlError('the address has no website name');
  if (host.split('.').some((label) => label === '')) throw new UnsafeUrlError('the website name is malformed');

  // The URL parser turns tricks like http://2130706433/ or http://0x7f.1/ into 127.0.0.1,
  // so testing the parsed host catches them. Every IP address, public or not, is refused:
  // real client websites are reached by name.
  if (host.startsWith('[') || host.includes(':')) throw new UnsafeUrlError('IP addresses are not allowed (use the website name)');
  if (/^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) throw new UnsafeUrlError('IP addresses are not allowed (use the website name)');

  if (PRIVATE_NAMES.has(host) || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError('it points to a private or reserved name');
  }
  if (!host.includes('.')) throw new UnsafeUrlError('it is not a public website name');
  if (!/^[a-z0-9.-]+$/.test(host) && !host.startsWith('xn--') && !/\.xn--/.test(host)) {
    throw new UnsafeUrlError('the website name contains unusual characters');
  }

  url.hash = '';
  return url;
}

/** "https://Example.com/a?b" -> "https://example.com". Throws UnsafeUrlError if unsafe. */
export function safeOrigin(input: string): string {
  return assertSafeUrl(input).origin;
}
