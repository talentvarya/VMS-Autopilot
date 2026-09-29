import { describe, expect, it } from 'vitest';
import { AnthropicCaptionProvider } from '@/lib/agents/social/caption-ai-provider';
import { NETWORK_LIMITS } from '@/lib/social/networks';

/**
 * REAL network call against the real Anthropic API. Costs real money when it runs.
 *
 * This file is SKIPPED unless a real ANTHROPIC_API_KEY is present in the environment running
 * the tests - it is never part of `npm run test`/`npm run check` in CI or in this repository's
 * own commit history, and no key is committed anywhere for it to find. To run it yourself:
 * set ANTHROPIC_API_KEY in your own shell (never in a committed file), then run
 * `npx vitest run tests/ai/anthropic-live.test.ts`.
 *
 * Nothing here writes to any database, calls draft_post, or touches any agent/permission code
 * - it only proves the SDK call shape itself (client construction, request/response parsing,
 * real usage numbers) works against the real API.
 */
const hasRealKey = typeof process.env.ANTHROPIC_API_KEY === 'string' && process.env.ANTHROPIC_API_KEY.startsWith('sk-ant-');

describe.skipIf(!hasRealKey)('AnthropicCaptionProvider - real API call (only runs with a real ANTHROPIC_API_KEY)', () => {
  it(
    'generates a real caption, within the requested network limit, with real usage numbers',
    async () => {
      const provider = new AnthropicCaptionProvider();
      const result = await provider.generateCaption({
        network: 'facebook',
        topic: 'A cozy neighborhood bakery just launched a new sourdough loaf',
        callToAction: 'Stop by this weekend',
      });
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.text.length).toBeLessThanOrEqual(NETWORK_LIMITS.facebook.maxChars);
      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBeGreaterThan(0);
    },
    30_000,
  );

  it(
    'refuses an oversized topic before ever reaching the network - same guard as the mock tests',
    async () => {
      const provider = new AnthropicCaptionProvider();
      await expect(provider.generateCaption({ network: 'facebook', topic: 'x'.repeat(1001) })).rejects.toThrow(/topic is too long/);
    },
    10_000,
  );
});
