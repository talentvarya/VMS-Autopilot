/**
 * Blog-to-social repurposing: turns a long-form piece (title + body, e.g. from a future
 * Content Agent) into one platform-adapted caption per requested network. Deterministic string
 * work only - no AI call.
 */

import type { Network } from '@/lib/social/types';
import { draftForEachNetwork } from './captions';

export interface BlogPost {
  title: string;
  body: string;
}

/** The first plain-text sentence of the blog body, used as the social "hook". */
function firstSentence(body: string): string {
  const plain = body.replace(/\s+/g, ' ').trim();
  const match = plain.match(/^[^.!?]*[.!?]/);
  return (match ? match[0] : plain).trim();
}

export function repurposeBlogPost(blog: BlogPost, networks: Network[]): Record<Network, string> {
  const hook = firstSentence(blog.body) || blog.title;
  const topic = `${blog.title} — ${hook}`;
  return draftForEachNetwork(topic, networks, 'Read the full article - link in bio.');
}
