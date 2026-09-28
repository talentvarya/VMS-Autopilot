import type { SocialProvider } from './provider';
import type { SocialStore } from './store';
import type { SocialPost } from './types';

/**
 * The in-memory counterpart of publish-worker.ts, used by the sample screen. It asks the store
 * to publish a post that is in "publishing" and returns the finished post. Safe to call twice.
 */
export async function processMemoryPublish(store: SocialStore, provider: SocialProvider, postId: string): Promise<SocialPost> {
  const before = store.post(postId)!;
  const result = await store.publish(postId, provider);
  return result.ok ? result.value : before;
}
