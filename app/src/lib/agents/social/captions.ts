/**
 * Caption, hashtag and CTA generation, and platform-specific adaptation - all scripted,
 * deterministic string assembly. No AI call, no network access. Reuses the EXISTING per-network
 * limits from src/lib/social/networks.ts rather than inventing new ones.
 */

import { NETWORK_LIMITS, charLength } from '@/lib/social/networks';
import type { Network } from '@/lib/social/types';

export interface CaptionInput {
  network: Network;
  topic: string;
  hashtags?: string[];
  callToAction?: string;
}

/** A single, deterministic caption for one network, trimmed to fit that network's own limit. */
export function draftCaption(input: CaptionInput): string {
  const limits = NETWORK_LIMITS[input.network];
  const cta = input.callToAction ?? 'Learn more in our bio.';
  const hashtags = (input.hashtags ?? defaultHashtags(input.topic)).slice(0, limits.hashtagsHard ?? 10);
  let body = `${input.topic.trim()}\n\n${cta}`;
  if (hashtags.length > 0) body += `\n\n${hashtags.map((h) => `#${h}`).join(' ')}`;
  if (charLength(body) > limits.maxChars) {
    // Trim the topic sentence first, keeping the CTA and hashtags intact where possible.
    const overBy = charLength(body) - limits.maxChars;
    const trimmedTopic = Array.from(input.topic.trim()).slice(0, Math.max(0, input.topic.trim().length - overBy - 1)).join('');
    body = `${trimmedTopic}…\n\n${cta}`;
    if (hashtags.length > 0) body += `\n\n${hashtags.map((h) => `#${h}`).join(' ')}`;
  }
  return body;
}

/** One idea, adapted separately for each requested network. */
export function draftForEachNetwork(topic: string, networks: Network[], callToAction?: string): Record<Network, string> {
  const out = {} as Record<Network, string>;
  for (const network of networks) out[network] = draftCaption({ network, topic, callToAction });
  return out;
}

function defaultHashtags(topic: string): string[] {
  const words = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 3);
  return words.length > 0 ? words : ['marketing'];
}
