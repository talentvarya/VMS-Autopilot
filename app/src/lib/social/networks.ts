import type { Network } from './types';

/**
 * Per-network limits. STARTING VALUES from each network's public guidance; networks change
 * them, so verify against the live rules before real accounts are connected.
 *
 * `maxChars` is a hard limit (the post would be rejected), counted in characters as a person
 * sees them (Unicode code points). The database enforces it too.
 * `hashtagsHard` is only set where the network itself refuses more (Instagram: 30).
 * `needsMedia` networks cannot publish a text-only post; Phase 3 has no uploads, so the app
 * warns instead of blocking.
 */
export interface NetworkLimits {
  maxChars: number;
  hashtagsHard: number | null;
  hashtagsAdvice: number;
  needsMedia: boolean;
}

export const NETWORK_LIMITS: Record<Network, NetworkLimits> = {
  instagram: { maxChars: 2200, hashtagsHard: 30, hashtagsAdvice: 10, needsMedia: true },
  facebook: { maxChars: 63206, hashtagsHard: null, hashtagsAdvice: 5, needsMedia: false },
  x: { maxChars: 280, hashtagsHard: null, hashtagsAdvice: 3, needsMedia: false },
  linkedin: { maxChars: 3000, hashtagsHard: null, hashtagsAdvice: 5, needsMedia: false },
  // A Google Business "Update" post is not accepted without a photo - unlike a plain status
  // update on the other networks, so this one is a hard requirement, not just advice.
  google_business: { maxChars: 1500, hashtagsHard: null, hashtagsAdvice: 0, needsMedia: true },
  youtube: { maxChars: 5000, hashtagsHard: null, hashtagsAdvice: 5, needsMedia: true },
  tiktok: { maxChars: 2200, hashtagsHard: null, hashtagsAdvice: 5, needsMedia: true },
};

/** Length as a person counts it (an emoji is one character), matching Postgres char_length. */
export const charLength = (text: string) => Array.from(text).length;

/** A web address inside the post text, the same pattern validate.ts checks for. */
const LINK = /https?:\/\/\S+/gi;
/** X (Twitter) shortens every link to exactly this many characters, whatever its real length. */
const X_LINK_LENGTH = 23;

/**
 * The length a network actually counts against its limit. Only X differs from a plain character
 * count today: it always counts a link as 23 characters, so a post with one long web address can
 * look "too long" by raw character count while X itself would accept it.
 */
export function effectiveLength(network: Network, body: string): number {
  if (network !== 'x') return charLength(body);
  const withoutLinks = body.replace(LINK, '');
  const linkCount = (body.match(LINK) ?? []).length;
  return charLength(withoutLinks) + linkCount * X_LINK_LENGTH;
}
