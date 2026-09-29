/**
 * Phase F.2 - a thin, single-purpose wrapper around the official Anthropic SDK.
 *
 * No other file in this codebase should import '@anthropic-ai/sdk' directly - every real AI
 * call goes through this module, so there is exactly one place that reads ANTHROPIC_API_KEY
 * (never logged, never returned, never included in any error message) and exactly one place
 * that knows the configured model name.
 */

import Anthropic from '@anthropic-ai/sdk';

/** claude-sonnet-5-5 by default - configurable through staging config via ANTHROPIC_MODEL. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

export class AnthropicNotConfiguredError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY is not set, or is not shaped like a real key. Real AI calls cannot run until it is configured.');
    this.name = 'AnthropicNotConfiguredError';
  }
}

/** Reads ANTHROPIC_MODEL if set and non-empty, otherwise the built-in default. */
export function getConfiguredModel(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ANTHROPIC_MODEL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_ANTHROPIC_MODEL;
}

/**
 * Builds a fresh SDK client from the current environment. Throws a clear, secret-free error
 * (never the SDK's own lower-level error, which could otherwise end up quoting a malformed
 * key) when ANTHROPIC_API_KEY is missing or does not even look like a real key.
 */
export function getAnthropicClient(env: NodeJS.ProcessEnv = process.env): Anthropic {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || !apiKey.startsWith('sk-ant-')) throw new AnthropicNotConfiguredError();
  return new Anthropic({ apiKey });
}
